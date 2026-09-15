// Turning what the reader asked for into path records: store paths walked
// from the caches, or a nix path-info --json document whose paths are
// then looked up in the caches to learn where their NARs are.

import { digestOf, walkClosure } from "./closure.js";
import { DIGEST_PATTERN, FETCH_CONCURRENCY } from "./config.js";
import { normalizeHash } from "./hash.js";
import { parsePathInfo } from "./import.js";
import { nameOf, pathRecord } from "./layout.js";
import { mapConcurrent } from "./net.js";
import { fetchNarinfo } from "./substituters.js";

// The digest of a store path, a basename, or a bare digest.
export function rootDigest(input) {
  const basename = input.trim().slice(input.trim().lastIndexOf("/") + 1);
  const digest = digestOf(basename);
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`not a store path: ${input}`);
  }
  return digest;
}

export function recordFromNarinfo(info) {
  const basename = info.storePath.slice(info.storePath.lastIndexOf("/") + 1);
  return pathRecord({
    digest: digestOf(basename),
    name: nameOf(basename),
    storePath: info.storePath,
    narSize: info.narSize,
    narHash: info.narHash,
    fileSize: info.fileSize,
    compression: info.compression,
    url: info.url,
    substituter: info.substituter,
    deriver: info.deriver,
    ca: info.ca,
    sigs: info.sigs,
    references: info.references.map(digestOf),
    referenceNames: info.references,
  });
}

// { records, roots, problems }. A reference no cache holds is a problem,
// not a failure: the rest of the closure still lays out.
export async function closureFromPaths(inputs, substituters, onProgress) {
  const roots = inputs.map(rootDigest);
  const { closure, missing } = await walkClosure(
    roots,
    (digest) => fetchNarinfo(digest, substituters),
    { onProgress },
  );
  return {
    records: [...closure.values()].map(recordFromNarinfo),
    roots: roots.filter((digest) => closure.has(digest)),
    problems: [...missing.values()],
  };
}

// { records, roots, problems }. Each imported path is looked up in the
// caches; one whose NAR hash a cache agrees with learns its URL and
// compression, and the rest stay local-only.
export async function closureFromJson(text, substituters, onProgress) {
  const { records, roots, errors } = parsePathInfo(text);
  let done = 0;

  await mapConcurrent(records, FETCH_CONCURRENCY, async (record) => {
    try {
      const info = await fetchNarinfo(record.digest, substituters);
      const agrees =
        record.narHash === null || normalizeHash(info.narHash) === record.narHash;
      if (agrees) {
        Object.assign(record, {
          narHash: record.narHash ?? info.narHash,
          url: info.url,
          compression: info.compression,
          fileSize: info.fileSize,
          substituter: info.substituter,
          deriver: record.deriver ?? info.deriver,
          sigs: record.sigs.length > 0 ? record.sigs : info.sigs,
        });
      }
    } catch {
      // No cache holds it: local-only.
    }
    done += 1;
    onProgress(done, records.length);
  });

  return { records, roots, problems: errors };
}
