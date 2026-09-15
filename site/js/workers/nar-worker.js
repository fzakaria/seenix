// A NAR worker: fetches one NAR at a time, streams it through the
// pipeline, and writes the raw bytes to OPFS as they decode. Several of
// these run side by side, each with its own decoder memory.
//
// Messages in:
//   { type: "closure", digests: [[digest, id], ...] }
//   { type: "fetch", job: { key, url, compression, narSize, narHash,
//                           storeRaw, memory } }
//   { type: "abort", key }
//
// Messages out:
//   { type: "progress", key, compressed, nar }
//   { type: "retry", key, message }
//   { type: "done", key, compressedBytes, narBytes, coarse, fine, index,
//     refs, rawStored, raw }
//   { type: "failed", key, aborted, failure, message }

import { PROGRESS_INTERVAL_MS } from "../config.js";
import { fetchRetrying } from "../net.js";
import { NarError, RETRYABLE, processNar } from "../nar-pipeline.js";
import { fileNameOf, opfsDirs } from "../storage.js";
import { RawStore } from "../tileformat.js";

// A NAR that fails a signed check is downloaded once more before it is
// reported failed.
const ATTEMPTS = 2;
const NETWORK_FAILURE = "network";

let digests = new Map();
const running = new Map();

self.onmessage = ({ data }) => {
  if (data.type === "closure") {
    digests = new Map(data.digests);
    return;
  }
  if (data.type === "abort") {
    running.get(data.key)?.abort();
    return;
  }
  if (data.type === "fetch") {
    run(data.job);
  }
};

async function run(job) {
  const controller = new AbortController();
  running.set(job.key, controller);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const outcome = await attemptOnce(job, controller.signal);
      const transfer = [outcome.coarse.buffer];
      if (outcome.fine !== null) {
        transfer.push(outcome.fine.buffer);
      }
      if (outcome.raw !== null) {
        transfer.push(outcome.raw.buffer);
      }
      self.postMessage({ type: "done", key: job.key, ...outcome }, transfer);
      break;
    } catch (err) {
      const aborted = controller.signal.aborted;
      const retryable =
        err instanceof NarError && RETRYABLE.has(err.failure) && !aborted;
      if (retryable && attempt < ATTEMPTS) {
        self.postMessage({ type: "retry", key: job.key, message: err.message });
        continue;
      }
      self.postMessage({
        type: "failed",
        key: job.key,
        aborted,
        failure: err.failure ?? NETWORK_FAILURE,
        message: err.message,
      });
      break;
    }
  }

  running.delete(job.key);
}

// One download. Raw bytes go to OPFS through a synchronous access handle
// when the job stores them and OPFS works, and otherwise into memory when
// the page asked for that.
async function attemptOnce(job, signal) {
  const dirs = job.storeRaw && !job.memory ? await opfsDirs() : null;
  const name = job.narHash ? fileNameOf(job.narHash) : null;

  let handle = null;
  if (dirs !== null && name !== null) {
    try {
      const file = await dirs.raw.getFileHandle(name, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
    } catch {
      handle = null;
    }
  }

  const chunks = job.storeRaw && job.memory ? [] : null;
  let written = 0;
  let sink = null;
  if (handle !== null) {
    sink = (chunk) => {
      handle.write(chunk, { at: written });
      written += chunk.length;
    };
  } else if (chunks !== null) {
    sink = (chunk) => chunks.push(chunk);
  }

  // Progress, at most every PROGRESS_INTERVAL_MS.
  let lastPost = 0;
  const onProgress = (compressed, nar) => {
    const now = performance.now();
    if (now - lastPost < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastPost = now;
    self.postMessage({ type: "progress", key: job.key, compressed, nar });
  };

  try {
    const res = await fetchRetrying(job.url, { signal });
    const result = await processNar({
      body: res.body,
      compression: job.compression,
      narSize: job.narSize,
      narHash: job.narHash,
      digests,
      sink,
      onProgress,
    });

    // The archive verified: keep its fine summaries beside it.
    let rawStored = null;
    if (handle !== null) {
      handle.flush();
      handle.close();
      handle = null;
      const fineFile = await dirs.fine.getFileHandle(name, { create: true });
      const fineHandle = await fineFile.createSyncAccessHandle();
      fineHandle.truncate(0);
      fineHandle.write(result.summary.fine, { at: 0 });
      fineHandle.flush();
      fineHandle.close();
      rawStored = RawStore.OPFS;
    } else if (chunks !== null) {
      rawStored = RawStore.MEMORY;
    }

    return {
      compressedBytes: result.compressedBytes,
      narBytes: result.narBytes,
      coarse: result.summary.coarse,
      fine: rawStored === RawStore.MEMORY ? result.summary.fine : null,
      index: result.index,
      refs: result.refs,
      rawStored,
      raw: chunks === null ? null : concat(chunks, result.narBytes),
    };
  } catch (err) {
    // Bytes that did not verify must not stay on disk.
    if (handle !== null) {
      try {
        handle.close();
      } catch {
        // already closed
      }
    }
    if (dirs !== null && name !== null) {
      await dirs.raw.removeEntry(name).catch(() => {});
    }
    throw err;
  }
}

function concat(chunks, total) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
