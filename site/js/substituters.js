// The binary caches seenix fetches from, and the signatures it checks.
//
// A cache is usable from a browser only if it allows cross-origin reads.
// cache.nixos.org sends `access-control-allow-origin: *` on narinfos and
// NARs alike.
//
// Extra caches ride in the page's link (url.js), tried in the order
// listed after the default. A local store served over HTTP with CORS
// headers (harmonia, or nix-serve behind a reverse proxy that adds them)
// is one more entry, and fills in the paths no public cache has.

import { CACHE_URL } from "./config.js";
import { parseNarinfo } from "./closure.js";
import { cachedResponse, storeInCache } from "./cache.js";

// How the page words a path that every configured cache answered for and
// none holds.
export const NOT_FOUND = "not found in any configured cache";

// Nix's own key for cache.nixos.org, so the default path verifies
// without the reader configuring anything.
export const DEFAULT_SUBSTITUTERS = [
  {
    url: CACHE_URL,
    key: "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=",
  },
];

// The signature verdicts verify() returns, named for the legend and the
// statistics panel.
export const Verified = Object.freeze({
  SIGNED: true,
  UNSIGNED: false,
  UNCHECKABLE: null,
});

// "https://host cache-name-1:base64key" per line, blanks ignored.
export function parseSubstituters(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [url, key] = line.split(/\s+/);
      if (url === undefined || key === undefined) {
        throw new Error(`each line needs a URL and a public key: "${line}"`);
      }
      return { url: url.replace(/\/$/, ""), key };
    });
}

const decodeBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// What a cache signs: the store path, its NAR hash and size, and its
// references, joined the way nix's own fingerprint does.
export function fingerprint(info) {
  const refs = info.references.map((r) => `/nix/store/${r}`).join(",");
  return `1;${info.storePath};${info.narHash};${info.narSize};${refs}`;
}

// Imported Ed25519 keys, by the key string, so a closure of thousands of
// paths imports each key once.
const importedKeys = new Map();

function importKey(material) {
  if (!importedKeys.has(material)) {
    importedKeys.set(
      material,
      crypto.subtle.importKey(
        "raw",
        decodeBase64(material),
        { name: "Ed25519" },
        false,
        ["verify"],
      ),
    );
  }
  return importedKeys.get(material);
}

// Verified.SIGNED when some configured key signed this narinfo,
// UNSIGNED when none did, and UNCHECKABLE when the browser cannot check
// Ed25519 at all (older Safari, Chrome before 137): a third state,
// because "unverifiable here" is not the same claim as "forged".
//
// Returns the key name that matched as well, for the legend.
export async function verify(info, substituters) {
  if (info.sigs.length === 0) {
    return { verdict: Verified.UNSIGNED, keyName: null };
  }
  if (globalThis.crypto?.subtle === undefined) {
    return { verdict: Verified.UNCHECKABLE, keyName: null };
  }

  for (const sig of info.sigs) {
    const [name, signature] = sig.split(":");
    const match = substituters.find((s) => s.key.startsWith(`${name}:`));
    if (match === undefined) {
      continue;
    }

    try {
      const key = await importKey(match.key.slice(name.length + 1));
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        decodeBase64(signature),
        new TextEncoder().encode(fingerprint(info)),
      );
      if (ok) {
        return { verdict: Verified.SIGNED, keyName: name };
      }
    } catch {
      // No Ed25519 in this browser: report the third state rather than
      // calling a signature never examined invalid.
      return { verdict: Verified.UNCHECKABLE, keyName: null };
    }
  }

  return { verdict: Verified.UNSIGNED, keyName: null };
}

// The first substituter holding this digest, with the narinfo it
// served. The NAR that follows must come from the same one, since a
// narinfo's URL is relative to the cache that served it.
//
// Narinfos are kept in the persistent cache: a store path's narinfo
// describes immutable bytes, so a cached one is never stale, and a walk
// done before costs no network. A cache that cannot be reached is
// skipped rather than fatal, since the next one may hold the path.
export async function fetchNarinfo(digest, substituters) {
  const failures = [];
  for (const substituter of substituters) {
    const url = `${substituter.url}/${digest}.narinfo`;
    let text;
    try {
      text = await fetchNarinfoText(url);
    } catch (err) {
      // A cross-origin refusal lands here with no status to inspect.
      failures.push(`${substituter.url}: ${err.message} (no CORS headers?)`);
      continue;
    }
    if (text === null) {
      continue;
    }
    const info = parseNarinfo(text);
    return { ...info, substituter: substituter.url };
  }

  if (failures.length > 0) {
    throw new Error(`${digest}: ${failures.join("; ")}`);
  }
  throw new Error(`${digest}: ${NOT_FOUND}`);
}

// The narinfo text, or null when the cache answers that it has no such
// path. Throws when the cache cannot be asked at all.
async function fetchNarinfoText(url) {
  const hit = await cachedResponse(url);
  if (hit !== null) {
    return hit.text();
  }

  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const text = await res.text();
  await storeInCache(url, new TextEncoder().encode(text));
  return text;
}
