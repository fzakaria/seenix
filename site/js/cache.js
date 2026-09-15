// A persistent cache for narinfos. A store path's narinfo describes
// immutable bytes, so a cached copy is never stale.
//
// Every call degrades to no caching at all: a private window, blocked
// site data, or a full quota costs a fetch, never an error.

const CACHE_NAME = "seenix-v1";

let cachePromise;
function openCache() {
  if (globalThis.caches === undefined) {
    return Promise.resolve(null);
  }
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

// The cached response for a URL, or null.
export async function cachedResponse(url) {
  const cache = await openCache();
  if (cache === null) {
    return null;
  }
  try {
    return (await cache.match(url)) ?? null;
  } catch {
    return null;
  }
}

// Keep bytes for next time. Failure is silent and harmless.
export async function storeInCache(url, bytes) {
  const cache = await openCache();
  if (cache === null) {
    return;
  }
  try {
    await cache.put(url, new Response(bytes));
  } catch {
    // out of quota, or storage denied: the next visit fetches again
  }
}
