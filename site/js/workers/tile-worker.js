// The tile worker: builds the two textures of a tile (tileformat.js) from
// the layout, the coarse summaries it is sent, and the raw bytes and fine
// summaries it reads from OPFS, or holds in memory when OPFS is absent.
//
// Messages in (every one carries the layout generation it belongs to):
//   { type: "layout", order, total, offsets, names }
//   { type: "coarse", ids, records }
//   { type: "files", ids, starts, ends }
//   { type: "raw", ids, available }
//   { type: "memory", name, raw, fine }
//   { type: "forget", name }
//   { type: "build", key, k, tx, ty }
//   { type: "read", requestId, name, kind, offset, length }
//
// Messages out:
//   { type: "tile", generation, key, k, tx, ty, data, ids }
//   { type: "read", requestId, bytes, error }

import {
  COARSE_CHUNK,
  FINE_CHUNK,
  LOD_COARSE,
  LOD_FINE,
  SUMMARY_RECORD,
  TILE_ORDER,
  TILE_SIZE,
} from "../config.js";
import { xy2d } from "../hilbert.js";
import { pathAt } from "../layout.js";
import { opfsDirs, readSlice } from "../storage.js";
import { ByteClass, CLASS_OF, Field } from "../summary.js";
import { HAS_BYTES, NO_PATH } from "../tileformat.js";

const TEXELS = TILE_SIZE * TILE_SIZE;
const MAX = 255;
const FIELDS = SUMMARY_RECORD;

const Kind = Object.freeze({ RAW: "raw", FINE: "fine" });

let generation = -1;
let order = TILE_ORDER;
let total = 0;
let offsets = new Float64Array(1);
let count = 0;
let names = [];
let rawAvailable = new Uint8Array(0);
let prefix = [];
let files = [];
const memory = new Map();

const handlers = {
  layout(message) {
    generation = message.generation;
    order = message.order;
    total = message.total;
    offsets = message.offsets;
    count = offsets.length - 1;
    names = message.names;
    rawAvailable = new Uint8Array(count);
    prefix = new Array(count);
    files = new Array(count);
    memory.clear();
  },

  // Cumulative sums of each field, so any run of chunks averages in O(1).
  coarse({ ids, records }) {
    const chunks = records.length / FIELDS;
    const sums = new Float64Array((chunks + 1) * FIELDS);
    for (let i = 0; i < chunks; i += 1) {
      for (let f = 0; f < FIELDS; f += 1) {
        sums[(i + 1) * FIELDS + f] = sums[i * FIELDS + f] + records[i * FIELDS + f];
      }
    }
    for (const id of ids) {
      prefix[id] = sums;
    }
  },

  files({ ids, starts, ends }) {
    for (const id of ids) {
      files[id] = { starts, ends };
    }
  },

  raw({ ids, available }) {
    for (const id of ids) {
      rawAvailable[id] = available ? 1 : 0;
    }
  },

  memory({ name, raw, fine }) {
    memory.set(name, { raw, fine });
  },

  forget({ name }) {
    memory.delete(name);
  },

  build(message) {
    build(message);
  },

  async read({ requestId, name, kind, offset, length }) {
    try {
      const bytes = await readNamed(name, kind, offset, length);
      self.postMessage({ type: "read", requestId, bytes: bytes.slice() });
    } catch (err) {
      self.postMessage({ type: "read", requestId, error: err.message });
    }
  },
};

self.onmessage = ({ data }) => {
  if (data.type !== "layout" && data.type !== "read" && data.generation !== generation) {
    return;
  }
  handlers[data.type]?.(data);
};

async function readNamed(name, kind, offset, length) {
  const held = memory.get(name);
  if (held !== undefined) {
    const source = kind === Kind.RAW ? held.raw : held.fine;
    return source.subarray(offset, offset + length);
  }
  const dirs = await opfsDirs();
  if (dirs === null) {
    throw new Error("no storage for raw bytes");
  }
  return readSlice(kind === Kind.RAW ? dirs.raw : dirs.fine, name, offset, length);
}

// Raw bytes (when `withRaw`) and fine records for every readable path
// overlapping [start, end). `bytes` is indexed from `start`; `fine` maps a
// path id to { first, records } with `first` the index of its first record.
async function gatherSources(start, end, withRaw) {
  const bytes = withRaw ? new Uint8Array(end - start) : null;
  const fine = new Map();
  const reads = [];

  for (let id = pathAt(offsets, start); id >= 0 && id < count && offsets[id] < end; id += 1) {
    if (rawAvailable[id] === 0 || names[id] === null) {
      continue;
    }
    const pathStart = offsets[id];
    const la = Math.max(start, pathStart) - pathStart;
    const lb = Math.min(end, offsets[id + 1]) - pathStart;
    if (lb <= la) {
      continue;
    }
    const r0 = Math.floor(la / FINE_CHUNK);
    const r1 = Math.ceil(lb / FINE_CHUNK);

    reads.push(
      (async () => {
        try {
          const [nar, records] = await Promise.all([
            withRaw ? readNamed(names[id], Kind.RAW, la, lb - la) : null,
            readNamed(names[id], Kind.FINE, r0 * FIELDS, (r1 - r0) * FIELDS),
          ]);
          if (nar !== null) {
            bytes.set(nar.subarray(0, lb - la), pathStart + la - start);
          }
          fine.set(id, { first: r0, records });
        } catch {
          // Evicted since, or unreadable: the texels stay empty.
        }
      })(),
    );
  }

  await Promise.all(reads);
  return { start, bytes, fine };
}

function fileOrdinal(id, local) {
  const lookup = files[id];
  if (lookup === undefined) {
    return 0;
  }
  const { starts, ends } = lookup;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= local) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo > 0 && local < ends[lo - 1] ? lo : 0;
}

// LOD 6 and coarser: the byte-weighted average of the coarse chunks of
// every summarised path the texel covers.
function fromCoarse(a, b, midId, data, at) {
  if (prefix[midId] === undefined) {
    return false;
  }
  let weight = 0;
  const sums = [0, 0, 0, 0];
  for (let id = pathAt(offsets, a); id >= 0 && id < count && offsets[id] < b; id += 1) {
    const p = prefix[id];
    if (p === undefined) {
      continue;
    }
    const la = Math.max(a, offsets[id]) - offsets[id];
    const lb = Math.min(b, offsets[id + 1]) - offsets[id];
    if (lb <= la) {
      continue;
    }
    const chunks = p.length / FIELDS - 1;
    const c0 = Math.min(chunks - 1, Math.floor(la / COARSE_CHUNK));
    const c1 = Math.min(chunks, Math.floor((lb - 1) / COARSE_CHUNK) + 1);
    const n = c1 - c0;
    if (n <= 0) {
      continue;
    }
    const w = lb - la;
    for (let f = 0; f < FIELDS; f += 1) {
      sums[f] += ((p[c1 * FIELDS + f] - p[c0 * FIELDS + f]) / n) * w;
    }
    weight += w;
  }
  if (weight === 0) {
    return false;
  }
  for (let f = 0; f < FIELDS; f += 1) {
    data[at + f] = Math.round(sums[f] / weight);
  }
  return true;
}

// LOD 4 and 5: the average of the fine records under the texel, from the
// path at its middle.
function fromFine(sources, a, b, id, data, at) {
  const held = sources.fine.get(id);
  if (held === undefined) {
    return false;
  }
  const records = held.records.length / FIELDS;
  const r0 = Math.max(0, Math.floor((a - offsets[id]) / FINE_CHUNK) - held.first);
  const r1 = Math.min(records, Math.ceil((b - offsets[id]) / FINE_CHUNK) - held.first);
  if (r1 <= r0) {
    return false;
  }
  for (let f = 0; f < FIELDS; f += 1) {
    let sum = 0;
    for (let r = r0; r < r1; r += 1) {
      sum += held.records[r * FIELDS + f];
    }
    data[at + f] = Math.round(sum / (r1 - r0));
  }
  return true;
}

// The entropy of the fine chunk holding a byte.
function fineEntropy(held, id, offset) {
  const r = Math.floor((offset - offsets[id]) / FINE_CHUNK) - held.first;
  return held.records[r * FIELDS + Field.ENTROPY] ?? 0;
}

// LOD 0 to 3: the byte itself at LOD 0, class fractions over the texel's
// bytes above that, and the fine chunk's entropy either way.
function fromRaw(sources, a, b, k, id, data, at) {
  const held = sources.fine.get(id);
  if (held === undefined) {
    return false;
  }
  const bytes = sources.bytes;
  const base = a - sources.start;
  data[at + Field.ENTROPY] = fineEntropy(held, id, a + (b - a) / 2);
  if (k === 0) {
    data[at] = bytes[base];
    return true;
  }

  const counts = [0, 0, 0, 0];
  const n = b - a;
  for (let i = 0; i < n; i += 1) {
    counts[CLASS_OF[bytes[base + i]]] += 1;
  }
  data[at + Field.ZERO] = Math.round((counts[ByteClass.ZERO] * MAX) / n);
  data[at + Field.ASCII] = Math.round((counts[ByteClass.ASCII] * MAX) / n);
  data[at + Field.HIGH] = Math.round((counts[ByteClass.HIGH] * MAX) / n);
  return true;
}

async function build({ generation: requested, key, k, tx, ty }) {
  const data = new Uint8Array(TEXELS * 4);
  const ids = new Uint32Array(TEXELS * 2);
  const texelOrder = order - k;
  const texelBytes = 4 ** k;
  const span = 4 ** (TILE_ORDER + k);
  const tileStart = xy2d(order - TILE_ORDER - k, tx, ty) * span;
  const tileEnd = Math.min(tileStart + span, total);

  let sources = null;
  if (k < LOD_COARSE && tileStart < total) {
    sources = await gatherSources(tileStart, tileEnd, k < LOD_FINE);
  }
  if (requested !== generation) {
    return;
  }

  for (let v = 0; v < TILE_SIZE; v += 1) {
    for (let u = 0; u < TILE_SIZE; u += 1) {
      const i = v * TILE_SIZE + u;
      const a = xy2d(texelOrder, tx * TILE_SIZE + u, ty * TILE_SIZE + v) * texelBytes;
      if (a >= total) {
        ids[2 * i] = NO_PATH;
        continue;
      }
      const b = Math.min(a + texelBytes, total);
      const mid = a + Math.floor((b - a) / 2);
      const id = pathAt(offsets, mid);
      ids[2 * i] = id;

      let present;
      if (k >= LOD_COARSE) {
        present = fromCoarse(a, b, id, data, 4 * i);
      } else if (k >= LOD_FINE) {
        present = fromFine(sources, a, b, id, data, 4 * i);
      } else {
        present = fromRaw(sources, a, b, k, id, data, 4 * i);
      }

      const ordinal = fileOrdinal(id, mid - offsets[id]);
      ids[2 * i + 1] = present ? (ordinal | HAS_BYTES) >>> 0 : ordinal;
    }
  }

  self.postMessage(
    { type: "tile", generation: requested, key, k, tx, ty, data, ids },
    [data.buffer, ids.buffer],
  );
}
