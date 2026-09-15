// Tests the graph analyses on hand-built closures whose answers are worked
// out by hand: a chain, a diamond, a cycle and several roots. Closure size
// must not double-count a diamond, retained size is the dominator subtree,
// and the why-here chain is a real reference chain from a root.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VIRTUAL_ROOT,
  WHY_ROOT,
  analyse,
  closureSizes,
  dominators,
  referrersOf,
  retainedSizes,
  whyChain,
  whyParents,
} from "../../site/js/graph.js";

// 0 -> 1 -> 2
const CHAIN = [[1], [2], []];

// 0 -> 1, 0 -> 2, 1 -> 3, 2 -> 3
const DIAMOND = [[1, 2], [3], [3], []];

test("a chain: each path dominates and retains everything below it", () => {
  const sizes = [1, 10, 100];
  assert.deepEqual([...closureSizes(CHAIN, sizes)], [111, 110, 100]);
  const { retained, idom } = retainedSizes(CHAIN, [0], sizes);
  assert.deepEqual([...retained], [111, 110, 100]);
  assert.deepEqual([...idom], [VIRTUAL_ROOT, 0, 1]);
});

test("a diamond: the shared bottom counts once and is retained by the top", () => {
  const sizes = [1, 10, 100, 1000];
  assert.deepEqual([...closureSizes(DIAMOND, sizes)], [1111, 1010, 1100, 1000]);
  const { retained, idom } = retainedSizes(DIAMOND, [0], sizes);
  assert.deepEqual([...idom], [VIRTUAL_ROOT, 0, 0, 0]);
  // Neither side of the diamond alone frees the bottom.
  assert.deepEqual([...retained], [1111, 10, 100, 1000]);
});

test("a cycle: every member reaches every other and sums stay finite", () => {
  // 0 -> 1 -> 2 -> 1, 2 -> 3
  const references = [[1], [2], [1, 3], []];
  const sizes = [1, 10, 100, 1000];
  assert.deepEqual([...closureSizes(references, sizes)], [1111, 1110, 1110, 1000]);
  const { retained, idom } = retainedSizes(references, [0], sizes);
  assert.deepEqual([...idom], [VIRTUAL_ROOT, 0, 1, 2]);
  assert.deepEqual([...retained], [1111, 1110, 1100, 1000]);
});

test("several roots: a path both roots share is dominated by neither", () => {
  // roots 0 and 1, both -> 2
  const references = [[2], [2], []];
  const sizes = [1, 10, 100];
  const { idom, order } = dominators(references, [0, 1]);
  assert.deepEqual([...idom], [VIRTUAL_ROOT, VIRTUAL_ROOT, VIRTUAL_ROOT]);
  assert.equal(order.length, 3);
  const { retained } = retainedSizes(references, [0, 1], sizes);
  assert.deepEqual([...retained], [1, 10, 100]);
});

test("why-here parents form a shortest chain from a root", () => {
  // 0 -> 1 -> 2 -> 3 and 0 -> 3 directly
  const references = [[1, 3], [2], [3], []];
  const parent = whyParents(references, [0]);
  assert.equal(parent[0], WHY_ROOT);
  assert.deepEqual(whyChain(parent, 3), [0, 3]);
  assert.deepEqual(whyChain(parent, 2), [0, 1, 2]);

  // Every step of a chain is a real reference.
  const chain = whyChain(parent, 2);
  for (let i = 1; i < chain.length; i += 1) {
    assert.ok(references[chain[i - 1]].includes(chain[i]));
  }
});

test("referrers are the reversed edges, and analyse bundles every result", () => {
  assert.deepEqual(referrersOf(DIAMOND), [[], [0], [0], [1, 2]]);
  const result = analyse(DIAMOND, [0], [1, 10, 100, 1000]);
  assert.deepEqual(Object.keys(result).sort(), [
    "closure",
    "idom",
    "referrers",
    "retained",
    "why",
  ]);
});
