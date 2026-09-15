// Fetch helpers: retries and bounded concurrency.

// A fetch can simply fail: a connection reset, a CDN hiccup, a browser
// declining under pressure. All of them arrive as a bare TypeError with
// no status and no URL. Retrying a few times turns most of them into a
// slower success.
const ATTEMPTS = 4;
const BACKOFF_MS = 400;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A response whose body has not been read yet, retried until the headers
// arrive with a 2xx. An abort is never retried.
export async function fetchRetrying(url, { signal } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (attempt >= ATTEMPTS) {
        throw new Error(`${url}: ${err.message}`);
      }
      await delay(BACKOFF_MS * attempt);
    }
  }
}

// Run tasks with a bounded number in flight, preserving result order.
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
