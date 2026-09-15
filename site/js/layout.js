// Laying a closure out along the curve: which path comes first, where
// each one starts, and how big the world has to be. Nothing here waits
// on a NAR; NarSize from the narinfo or the imported JSON is enough.

import { MIN_ORDER, STORE_DIR } from "./config.js";

// One store path as the rest of the page sees it, before layout. Every
// closure source (a walk from caches, an imported path-info JSON) builds
// these, and buildLayout() gives each an id and a place on the curve.
//
//   digest, name, storePath, narSize, narHash, fileSize, compression,
//   url, substituter (null when no cache holds the path),
//   references (digests, self included when present), deriver, ca, sigs
export function pathRecord(fields) {
  return {
    fileSize: 0,
    compression: null,
    url: null,
    substituter: null,
    deriver: null,
    ca: null,
    sigs: [],
    ...fields,
  };
}

// Basename after "<digest>-".
export const nameOf = (basename) => basename.slice(33);

export const storePathOf = (digest, name) => `${STORE_DIR}/${digest}-${name}`;

// Sorted, numbered and placed.
//
// Roots come first so the toplevel sits at the curve's start. Everything
// else sorts by name, then digest: name-sorting groups related packages
// and keeps the layouts of similar closures visually similar.
//
// Returns { paths, offsets, total, order, byDigest, roots }. `offsets` is
// a Float64Array of length paths.length + 1 whose last entry is the total;
// JS numbers are exact to 2^53, far beyond any closure. References become
// path ids with the self-reference removed and kept as a flag, and a
// reference to a digest outside the set is dropped.
export function buildLayout(records, rootDigests) {
  const rootRank = new Map(rootDigests.map((digest, i) => [digest, i]));
  const sorted = [...records].sort((a, b) => {
    const ra = rootRank.get(a.digest) ?? Infinity;
    const rb = rootRank.get(b.digest) ?? Infinity;
    if (ra !== rb) {
      return ra - rb;
    }
    if (a.name !== b.name) {
      return a.name < b.name ? -1 : 1;
    }
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
  });

  // Number the paths in curve order.
  const byDigest = new Map(sorted.map((record, id) => [record.digest, id]));

  // Place each path directly after the previous one, with no alignment
  // padding between them.
  const offsets = new Float64Array(sorted.length + 1);
  const paths = sorted.map((record, id) => {
    offsets[id + 1] = offsets[id] + record.narSize;
    const references = [];
    let selfRef = false;
    for (const digest of record.references) {
      if (digest === record.digest) {
        selfRef = true;
        continue;
      }
      const ref = byDigest.get(digest);
      if (ref === undefined) {
        continue;
      }
      references.push(ref);
    }
    return { ...record, id, start: offsets[id], references, selfRef };
  });

  const total = offsets[sorted.length];
  const roots = rootDigests
    .map((digest) => byDigest.get(digest))
    .filter((id) => id !== undefined);
  return { paths, offsets, total, order: orderFor(total), byDigest, roots };
}

// The smallest even-sided world holding `total` bytes: ceil(log4(total)),
// never below one tile. Bytes beyond the total are padding.
export function orderFor(total) {
  let order = MIN_ORDER;
  while (4 ** order < total) {
    order += 1;
  }
  return order;
}

// The path whose byte range holds offset d, or -1 for padding. A binary
// search for the last start not after d.
export function pathAt(offsets, d) {
  const count = offsets.length - 1;
  if (d < 0 || d >= offsets[count]) {
    return -1;
  }
  let lo = 0;
  let hi = count;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] <= d) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Zero-byte paths share a start with their successor; the search lands
  // on the last of them, which is the one that owns d.
  return lo;
}
