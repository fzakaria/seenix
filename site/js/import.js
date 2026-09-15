// Reading a closure from `nix path-info -r --json`, in every shape Nix
// has written it:
//
//   an array of objects with a `path` field       Nix before 2.19
//   an object keyed by full store path            --json-format 1
//   { info: { <basename>: {...} }, storeDir }     --json-format 2
//
// Across those, `references` and `deriver` are full store paths or bare
// basenames, and `narHash` is SRI (sha256-<base64>), sha256:<nix32> or
// hex. Every one of them becomes the same pathRecord (layout.js), with the
// hash normalised to the narinfo spelling so signatures on imported paths
// can still be checked. `narSize` must be present: without it there is no
// layout.

import { DIGEST_LENGTH, DIGEST_PATTERN } from "./config.js";
import { normalizeHash } from "./hash.js";
import { nameOf, pathRecord, storePathOf } from "./layout.js";

// The basename of a store path, or the value unchanged if it already is
// one.
const basenameOf = (value) => value.slice(value.lastIndexOf("/") + 1);

// The (path, fields) pairs of any of the three shapes.
function entriesOf(json) {
  if (Array.isArray(json)) {
    return json.map((entry) => [entry.path, entry]);
  }
  if (json !== null && typeof json === "object" && "info" in json) {
    return Object.entries(json.info);
  }
  if (json !== null && typeof json === "object") {
    return Object.entries(json);
  }
  throw new Error("not a nix path-info --json document");
}

// { records, roots, errors }. Roots are the paths nothing else in the set
// refers to. A path with no NAR size is reported and left out rather than
// failing the whole import, since the rest can still be drawn; an entry
// Nix wrote as null (a path it could not find) is dropped the same way.
export function parsePathInfo(text) {
  const json = typeof text === "string" ? JSON.parse(text) : text;
  const records = [];
  const errors = [];

  for (const [path, fields] of entriesOf(json)) {
    const basename = basenameOf(String(path ?? ""));
    const digest = basename.slice(0, DIGEST_LENGTH);
    if (!DIGEST_PATTERN.test(digest)) {
      errors.push(`${path}: not a store path`);
      continue;
    }
    if (fields === null || typeof fields !== "object") {
      errors.push(`${path}: nix did not describe this path`);
      continue;
    }
    if (typeof fields.narSize !== "number") {
      errors.push(`${path}: no narSize`);
      continue;
    }

    let narHash = null;
    try {
      narHash = fields.narHash ? normalizeHash(fields.narHash) : null;
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
    }

    const name = nameOf(basename);
    records.push(
      pathRecord({
        digest,
        name,
        storePath: storePathOf(digest, name),
        narSize: fields.narSize,
        narHash,
        references: (fields.references ?? []).map((ref) =>
          basenameOf(ref).slice(0, DIGEST_LENGTH),
        ),
        referenceNames: (fields.references ?? []).map(basenameOf),
        deriver: fields.deriver ? basenameOf(fields.deriver) : null,
        ca: fields.ca ?? null,
        sigs: fields.signatures ?? [],
      }),
    );
  }

  return { records, roots: rootsOf(records), errors };
}

// The digests nothing else in the set refers to, in input order.
export function rootsOf(records) {
  const referred = new Set();
  for (const record of records) {
    for (const ref of record.references) {
      if (ref !== record.digest) {
        referred.add(ref);
      }
    }
  }
  return records
    .map((record) => record.digest)
    .filter((digest) => !referred.has(digest));
}
