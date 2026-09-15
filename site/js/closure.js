// Fetching and parsing narinfos from binary caches, and walking a runtime
// closure from them.

import { DIGEST_LENGTH, FETCH_CONCURRENCY } from "./config.js";

// A narinfo is "Key: value" lines. References holds the store basenames
// of the direct runtime dependencies; a path may reference itself.
export function parseNarinfo(text) {
  const fields = {};
  // A path signed by several keys carries a Sig line each, so they are
  // collected rather than overwritten.
  const sigs = [];

  for (const line of text.split("\n")) {
    const sep = line.indexOf(": ");
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    if (key === "Sig") {
      sigs.push(value);
      continue;
    }
    fields[key] = value;
  }

  return {
    storePath: fields.StorePath,
    url: fields.URL,
    // An absent Compression field, and an empty one, both mean bzip2:
    // nix's own reader defaults them that way.
    compression: fields.Compression || "bzip2",
    // FileSize is informational: no signature covers it, and a cache
    // that recompresses leaves it stale.
    fileSize: Number(fields.FileSize ?? 0),
    narSize: Number(fields.NarSize ?? 0),
    narHash: fields.NarHash,
    deriver: fields.Deriver ?? null,
    ca: fields.CA ?? null,
    sigs,
    references: (fields.References ?? "").split(" ").filter(Boolean),
  };
}

// The digest is the leading 32 characters of a store basename.
export const digestOf = (basename) => basename.slice(0, DIGEST_LENGTH);

// Breadth-first walk from root digests to the full runtime closure,
// FETCH_CONCURRENCY narinfos in flight at a time. Returns a Map of
// digest -> narinfo (with the substituter that served it) in discovery
// order; onProgress hears the count as it grows.
//
// `fetchInfo(digest)` resolves to a narinfo or rejects. A reference that
// no cache holds does not abandon the walk: the path is recorded in
// `missing` with the reason, and the map simply lacks it.
export async function walkClosure(
  rootDigests,
  fetchInfo,
  { onProgress = () => {} } = {},
) {
  const closure = new Map();
  const missing = new Map();
  const enqueued = new Set(rootDigests);
  let frontier = [...enqueued];

  while (frontier.length > 0) {
    const next = [];

    for (let i = 0; i < frontier.length; i += FETCH_CONCURRENCY) {
      const batch = frontier.slice(i, i + FETCH_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(fetchInfo));

      // Record the batch, then queue every reference the walk has not
      // seen; the enqueued set is what keeps a diamond dependency from
      // being fetched twice.
      for (const [j, result] of settled.entries()) {
        const digest = batch[j];
        if (result.status === "rejected") {
          missing.set(digest, result.reason?.message ?? String(result.reason));
          continue;
        }

        const info = result.value;
        closure.set(digest, info);
        onProgress(closure.size);

        for (const ref of info.references) {
          const refDigest = digestOf(ref);
          if (enqueued.has(refDigest)) {
            continue;
          }
          enqueued.add(refDigest);
          next.push(refDigest);
        }
      }
    }

    frontier = next;
  }

  return { closure, missing };
}
