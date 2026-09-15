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

// Version ordering good enough to pick the newest: numeric runs compare
// as numbers, everything else lexically, and a release sorts above its
// own prereleases because the shorter run wins when every shared
// component is equal.
export function compareVersions(a, b) {
  const split = (v) => v.split(/[.\-_+]/).filter(Boolean);
  const pa = split(a);
  const pb = split(b);

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
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
