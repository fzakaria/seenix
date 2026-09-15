// The nixpkgs-multiverse index, fetched straight from the deployed site
// (CORS is open on it). Two questions: which store path is
// `attr@version` (for ?pkg=), and which attribute and version is a
// digest (for the legend).
//
//   meta-<system>/<shard>.json   the store-path digest per version
//   identify/<shard>.json        digest -> the (attribute, version) it is

import { MULTIVERSE_SITE_SYSTEM, MULTIVERSE_URL, SYSTEM } from "./config.js";

// The index's shard of an attribute: its first two characters, not
// padded, so a one-character attribute lands in a one-character shard.
export const shardOf = (attr) =>
  [...attr.slice(0, 2).toLowerCase()]
    .map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
    .join("") || "_";

const shardCache = new Map();

function fetchShard(dir, attr) {
  const key = `${dir}/${shardOf(attr)}`;
  if (!shardCache.has(key)) {
    shardCache.set(
      key,
      fetch(`${MULTIVERSE_URL}/${key}.json`).then((res) => {
        // A missing shard means no attribute starts with those
        // characters, which is the same answer as a shard that loads
        // and does not hold it.
        if (!res.ok) {
          return { attrs: {} };
        }
        return res.json();
      }),
    );
  }
  return shardCache.get(key);
}

let namesPromise;

// The autocomplete corpus: attribute -> how many versions it ever had.
export function attrNames() {
  namesPromise ??= fetch(`${MULTIVERSE_URL}/names.json`)
    .then((res) => res.json())
    .then((json) => json.attrs);
  return namesPromise;
}

// Whether a version has an x86_64-linux store path to map.
export const bootable = (version) => version.storePath !== null;

// One meta-shard entry as a version record.
function built(attr, version, entry) {
  const name = entry.n ?? `${attr}-${version}`;
  return {
    attr,
    version,
    digest: entry.d,
    name,
    storePath: `/nix/store/${entry.d}-${name}`,
    closureSize: entry.cs ?? 0,
  };
}

// A version nixpkgs shipped that Hydra never built for this system.
const unbuilt = (attr, version) => ({
  attr,
  version,
  digest: null,
  name: `${attr}-${version}`,
  storePath: null,
  closureSize: 0,
});

// Every version nixpkgs ever shipped of an attribute, newest first: the
// ones with a store path for this system from the meta shard, and the
// rest, from the versions shard, with none. Pure, so the join is testable
// without the network.
export function mergeVersions(attr, indexed, entries) {
  const versions = new Set([
    ...Object.keys(indexed ?? {}),
    ...Object.keys(entries ?? {}),
  ]);
  return [...versions]
    .map((version) =>
      entries?.[version] === undefined
        ? unbuilt(attr, version)
        : built(attr, version, entries[version]),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

// An attribute's version rows, both shards fetched at once.
export async function versionRowsOf(attr) {
  const [meta, all] = await Promise.all([
    fetchShard(`meta-${SYSTEM}`, attr),
    fetchShard("versions", attr),
  ]);
  return mergeVersions(attr, all.attrs?.[attr], meta.attrs?.[attr]);
}

// Attributes whose name contains the query, best matches first: exact,
// then prefix, then substring, each alphabetically within its class.
export async function searchAttrs(query, limit) {
  const names = await attrNames();
  const q = query.toLowerCase();
  const rank = (name) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
  return Object.keys(names)
    .filter((name) => name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, limit)
    .map((name) => ({ attr: name, versionCount: names[name] }));
}

// Version ordering good enough to pick the newest: numeric runs compare
// as numbers, everything else lexically. When one version has components
// left after every shared one is equal, a numeric one makes it a later
// release (1.2 < 1.2.1) and anything else makes it a prerelease
// (1.2-rc1 < 1.2).
export function compareVersions(a, b) {
  const split = (v) => v.split(/[.\-_+]/).filter(Boolean);
  const pa = split(a);
  const pb = split(b);

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined || y === undefined) {
      const rest = x ?? y;
      const later = /^\d/.test(rest);
      const aIsShorter = x === undefined;
      return aIsShorter === later ? -1 : 1;
    }
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) {
      if (nx !== ny) {
        return nx - ny;
      }
      continue;
    }
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// The store path for `attr` at `version`, or at its newest version with
// an x86_64-linux build when `version` is null. Throws when the index
// has no build.
export async function resolvePackage(attr, version) {
  const meta = await fetchShard(`meta-${SYSTEM}`, attr);
  const entries = meta.attrs?.[attr];
  if (entries === undefined) {
    throw new Error(`${attr}: not in the nixpkgs-multiverse index`);
  }

  const versions = Object.keys(entries).sort((a, b) => compareVersions(b, a));
  const chosen = version ?? versions[0];
  const entry = entries[chosen];
  if (entry === undefined) {
    throw new Error(`${attr}@${chosen}: no ${SYSTEM} build in the index`);
  }
  const name = entry.n ?? `${attr}-${chosen}`;
  return `/nix/store/${entry.d}-${name}`;
}

// What store path a digest is, when the index knows: { attr, version },
// or null. A shard is a few tens of KB, so a lookup costs one small
// fetch and nothing the second time.
const identifyCache = new Map();

export function identify(digest) {
  const shard = digest.slice(0, 2);
  if (!identifyCache.has(shard)) {
    identifyCache.set(
      shard,
      fetch(`${MULTIVERSE_URL}/identify/${shard}.json`)
        .then((res) => (res.ok ? res.json() : {}))
        // A path nobody can name is still a path on the map, so a failed
        // lookup answers "unknown" rather than throwing.
        .catch(() => ({})),
    );
  }
  return identifyCache.get(shard).then((entries) => {
    const hit = entries[digest];
    return hit === undefined ? null : { attr: hit[0], version: hit[1] };
  });
}

// The page on nixmultiverse.com for one version of an attribute. `sys`
// is left off when the system is the one that site already shows, which
// makes every link the canonical URL it would write for itself.
export function multiverseUrl({ attr, version = null }) {
  const params = new URLSearchParams({ pkg: attr });
  if (version !== null) {
    params.set("ver", version);
  }
  if (SYSTEM !== MULTIVERSE_SITE_SYSTEM) {
    params.set("sys", SYSTEM);
  }
  return `${MULTIVERSE_URL}/?${params}`;
}
