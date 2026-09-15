// Graph analysis over a laid-out closure: who refers to a path, why it
// is in the closure at all, how big its own closure is, and how many
// bytes would go if it were removed. Pure functions over path ids, run
// in graph-worker.js so a closure of 10k paths never blocks a frame.
//
// The input is `references`: for each path id, the ids it refers to,
// self-references already removed (layout.js), plus the root ids.
// Several roots hang off a virtual root, so every analysis has a single
// entry point.

// Reverse edges.
export function referrersOf(references) {
  const referrers = references.map(() => []);
  for (const [from, refs] of references.entries()) {
    for (const to of refs) {
      referrers[to].push(from);
    }
  }
  return referrers;
}

// Breadth-first parents from the roots: whyParent[id] is the path that
// first pulled id in, -1 for a root, and -2 for a path no root reaches.
// The breadcrumb for a path is its parent chain, which is a shortest
// reference chain from a root.
export const WHY_ROOT = -1;
export const WHY_UNREACHABLE = -2;

export function whyParents(references, roots) {
  const parent = new Int32Array(references.length).fill(WHY_UNREACHABLE);
  const queue = [];
  for (const root of roots) {
    parent[root] = WHY_ROOT;
    queue.push(root);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const ref of references[id]) {
      if (parent[ref] !== WHY_UNREACHABLE) {
        continue;
      }
      parent[ref] = id;
      queue.push(ref);
    }
  }
  return parent;
}

// The chain from a root down to id, root first.
export function whyChain(parent, id) {
  const chain = [];
  for (let at = id; at >= 0; at = parent[at]) {
    chain.push(at);
  }
  return chain.reverse();
}

// Strongly connected components, Tarjan's algorithm run with an explicit
// stack so a deep chain cannot overflow the call stack. An imported JSON
// can carry a reference cycle, and a cycle must not break the sums.
//
// Returns component ids in reverse topological order of the condensation:
// every edge goes from a higher component id to a lower or equal one.
export function stronglyConnected(references) {
  const n = references.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const component = new Int32Array(n).fill(-1);
  const stack = [];
  let nextIndex = 0;
  let nextComponent = 0;

  for (let start = 0; start < n; start += 1) {
    if (index[start] !== -1) {
      continue;
    }

    // Each frame is a node and how many of its edges have been followed.
    const frames = [[start, 0]];
    index[start] = low[start] = nextIndex++;
    stack.push(start);
    onStack[start] = 1;

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [v, edge] = frame;

      // Follow the next edge, descending into an unvisited node.
      if (edge < references[v].length) {
        frame[1] += 1;
        const w = references[v][edge];
        if (index[w] === -1) {
          index[w] = low[w] = nextIndex++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
          continue;
        }
        if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
        continue;
      }

      // Every edge followed: close a component if v is its root, then
      // hand v's low link to its parent frame.
      frames.pop();
      if (low[v] === index[v]) {
        for (;;) {
          const w = stack.pop();
          onStack[w] = 0;
          component[w] = nextComponent;
          if (w === v) {
            break;
          }
        }
        nextComponent += 1;
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
    }
  }

  return { component, count: nextComponent };
}

// The closure size of every path: the sum of narSize over everything it
// reaches, itself included.
//
// Memoized sums over the DAG double-count diamonds, so reachability is
// carried as bitsets over the condensation instead, filled in reverse
// topological order: a component's set is its own members or'd with the
// sets of the components it refers to. A 10k-path closure is about 12 MB
// of bits.
const WORD_BITS = 32;

export function closureSizes(references, sizes) {
  const n = references.length;
  const { component, count } = stronglyConnected(references);
  const words = Math.ceil(n / WORD_BITS);
  const bits = new Uint32Array(Math.max(1, count * words));

  // Members of each component, and the components each one points into.
  const members = Array.from({ length: count }, () => []);
  for (let v = 0; v < n; v += 1) {
    members[component[v]].push(v);
  }

  // Components are numbered so that edges point to lower ids, which are
  // therefore complete by the time a higher one reads them.
  for (let c = 0; c < count; c += 1) {
    const base = c * words;
    for (const v of members[c]) {
      bits[base + ((v / WORD_BITS) | 0)] |= 1 << (v % WORD_BITS);
    }
    for (const v of members[c]) {
      for (const w of references[v]) {
        const other = component[w];
        if (other === c) {
          continue;
        }
        const from = other * words;
        for (let i = 0; i < words; i += 1) {
          bits[base + i] |= bits[from + i];
        }
      }
    }
  }

  // Sum sizes over each component's set bits, skipping empty words.
  const componentSize = new Float64Array(count);
  for (let c = 0; c < count; c += 1) {
    const base = c * words;
    let sum = 0;
    for (let i = 0; i < words; i += 1) {
      let word = bits[base + i];
      while (word !== 0) {
        const bit = 31 - Math.clz32(word & -word);
        sum += sizes[i * WORD_BITS + bit];
        word &= word - 1;
      }
    }
    componentSize[c] = sum;
  }

  const result = new Float64Array(n);
  for (let v = 0; v < n; v += 1) {
    result[v] = componentSize[component[v]];
  }
  return result;
}

// Immediate dominators, by the Cooper-Harvey-Kennedy iterative algorithm
// over reverse postorder from a virtual root that refers to every real
// root. idom[id] is the path every chain from a root to id must pass
// through last, VIRTUAL_ROOT when only the virtual root dominates it, and
// -1 when no root reaches it. CHK handles general graphs, cycles
// included.
export const VIRTUAL_ROOT = -1;
const UNREACHED = -2;

export function dominators(references, roots) {
  const n = references.length;
  const root = n;
  const successors = (v) => (v === root ? roots : references[v]);

  // Reverse postorder by iterative DFS from the virtual root.
  const order = [];
  const rpoNumber = new Int32Array(n + 1).fill(-1);
  const visited = new Uint8Array(n + 1);
  const frames = [[root, 0]];
  visited[root] = 1;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const [v, edge] = frame;
    const succ = successors(v);
    if (edge < succ.length) {
      frame[1] += 1;
      const w = succ[edge];
      if (!visited[w]) {
        visited[w] = 1;
        frames.push([w, 0]);
      }
      continue;
    }
    frames.pop();
    order.push(v);
  }
  order.reverse();
  for (const [i, v] of order.entries()) {
    rpoNumber[v] = i;
  }

  // Predecessors, restricted to reachable nodes.
  const preds = Array.from({ length: n + 1 }, () => []);
  for (const v of order) {
    for (const w of successors(v)) {
      preds[w].push(v);
    }
  }

  const idom = new Int32Array(n + 1).fill(UNREACHED);
  idom[root] = root;

  // Walk two fingers up the partial dominator tree until they meet.
  const intersect = (a, b) => {
    while (a !== b) {
      while (rpoNumber[a] > rpoNumber[b]) {
        a = idom[a];
      }
      while (rpoNumber[b] > rpoNumber[a]) {
        b = idom[b];
      }
    }
    return a;
  };

  for (let changed = true; changed;) {
    changed = false;
    for (const v of order) {
      if (v === root) {
        continue;
      }
      let candidate = UNREACHED;
      for (const p of preds[v]) {
        if (idom[p] === UNREACHED) {
          continue;
        }
        candidate = candidate === UNREACHED ? p : intersect(p, candidate);
      }
      if (candidate !== UNREACHED && idom[v] !== candidate) {
        idom[v] = candidate;
        changed = true;
      }
    }
  }

  // Report against real ids: the virtual root is VIRTUAL_ROOT, and
  // anything the walk never reached is -1 as well but flagged apart.
  const result = new Int32Array(n);
  for (let v = 0; v < n; v += 1) {
    const d = idom[v];
    result[v] = d === root ? VIRTUAL_ROOT : d === UNREACHED ? UNREACHED : d;
  }
  return { idom: result, order: order.filter((v) => v !== root) };
}

// Retained size: the sum of narSize over each path's dominator subtree,
// which is the bytes that would leave the closure if the path did.
// Children come after their dominator in reverse postorder, so a single
// pass from the end folds every subtree into its parent.
export function retainedSizes(references, roots, sizes) {
  const { idom, order } = dominators(references, roots);
  const retained = Float64Array.from(sizes);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const v = order[i];
    const parent = idom[v];
    if (parent >= 0) {
      retained[parent] += retained[v];
    }
  }
  return { retained, idom };
}

// Every analysis the legend shows, at once.
export function analyse(references, roots, sizes) {
  const referrers = referrersOf(references);
  const why = whyParents(references, roots);
  const closure = closureSizes(references, sizes);
  const { retained, idom } = retainedSizes(references, roots, sizes);
  return { referrers, why, closure, retained, idom };
}
