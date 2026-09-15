// Scheduling NAR downloads across the worker pool: what to fetch first,
// what to abort when it scrolls away, and which stored NARs to evict to
// stay within the raw-byte budget. Jobs are keyed by NAR hash, so paths
// with identical contents download once.

import {
  ABORT_BELOW_FRACTION,
  ABORT_OFFSCREEN_MS,
  FINE_CHUNK,
  NAR_WORKERS,
  SUMMARY_RECORD,
} from "./config.js";

export const FetchEvent = Object.freeze({
  QUEUED: "queued",
  STARTED: "started",
  PROGRESS: "progress",
  RETRY: "retry",
  DONE: "done",
  FAILED: "failed",
  DROPPED: "dropped",
  EVICT: "evict",
});

// A stored NAR's footprint: the archive and its fine summaries.
export const storedBytes = (narSize) =>
  narSize + Math.ceil(narSize / FINE_CHUNK) * SUMMARY_RECORD;

export class Fetcher {
  constructor({ budget, memory, onEvent }) {
    this.budget = budget;
    this.memory = memory;
    this.onEvent = onEvent;
    this.jobs = new Map();
    this.stored = new Map();
    this.storedTotal = 0;
    this.reserved = 0;
    this.sessionBytes = 0;
    this.lastProtected = new Set();

    this.workers = Array.from({ length: NAR_WORKERS }, () => {
      const worker = new Worker(
        new URL("./workers/nar-worker.js", import.meta.url),
        {
          type: "module",
        },
      );
      worker.onmessage = ({ data }) => this.receive(worker, data);
      return worker;
    });
    this.idle = [...this.workers];
  }

  // A new closure: every job belongs to the old one. Workers still busy
  // come back to the pool when they report.
  reset(digests) {
    for (const job of this.jobs.values()) {
      job.worker?.postMessage({ type: "abort", key: job.narHash });
    }
    this.jobs.clear();
    this.reserved = 0;
    for (const worker of this.workers) {
      worker.postMessage({ type: "closure", digests });
    }
  }

  // Queue jobs: [{ narHash, url, compression, narSize, fileSize, priority }].
  // An explicit job survives scrolling away.
  request(jobs, explicit) {
    for (const spec of jobs) {
      if (this.stored.has(spec.narHash)) {
        continue;
      }
      const existing = this.jobs.get(spec.narHash);
      if (existing !== undefined) {
        existing.priority = Math.min(existing.priority, spec.priority);
        existing.explicit ||= explicit;
        continue;
      }
      const job = {
        ...spec,
        explicit,
        worker: null,
        reserve: 0,
        compressed: 0,
        nar: 0,
        offscreenSince: null,
        aborting: false,
      };
      this.jobs.set(spec.narHash, job);
      this.onEvent(FetchEvent.QUEUED, job);
    }
  }

  // Drop queued jobs that left the viewport, and abort downloads that
  // have been off screen a while and are not far along.
  viewport(visibleHashes, now = performance.now()) {
    for (const job of [...this.jobs.values()]) {
      if (job.explicit) {
        continue;
      }
      if (visibleHashes.has(job.narHash)) {
        job.offscreenSince = null;
        continue;
      }
      if (job.worker === null) {
        this.jobs.delete(job.narHash);
        this.onEvent(FetchEvent.DROPPED, job);
        continue;
      }
      job.offscreenSince ??= now;
      const fraction = job.narSize > 0 ? job.nar / job.narSize : 1;
      if (
        !job.aborting &&
        now - job.offscreenSince > ABORT_OFFSCREEN_MS &&
        fraction < ABORT_BELOW_FRACTION
      ) {
        job.aborting = true;
        job.worker.postMessage({ type: "abort", key: job.narHash });
      }
    }
  }

  // Start queued jobs on idle workers, nearest and smallest first.
  pump(protectedHashes = this.lastProtected) {
    this.lastProtected = protectedHashes;
    const queued = [...this.jobs.values()]
      .filter((job) => job.worker === null)
      .sort((a, b) => a.priority - b.priority || a.fileSize - b.fileSize);

    for (const job of queued) {
      if (this.idle.length === 0) {
        return;
      }
      const need = storedBytes(job.narSize);
      const storeRaw = this.makeRoom(need, protectedHashes);
      job.reserve = storeRaw ? need : 0;
      this.reserved += job.reserve;
      job.worker = this.idle.pop();
      job.worker.postMessage({
        type: "fetch",
        job: {
          key: job.narHash,
          url: job.url,
          compression: job.compression,
          narSize: job.narSize,
          narHash: job.narHash,
          storeRaw,
          memory: this.memory,
        },
      });
      this.onEvent(FetchEvent.STARTED, job);
    }
  }

  cancelExplicit() {
    for (const job of [...this.jobs.values()]) {
      if (!job.explicit) {
        continue;
      }
      if (job.worker === null) {
        this.jobs.delete(job.narHash);
        this.onEvent(FetchEvent.DROPPED, job);
        continue;
      }
      job.explicit = false;
      job.aborting = true;
      job.worker.postMessage({ type: "abort", key: job.narHash });
    }
  }

  receive(worker, data) {
    const job = this.jobs.get(data.key);
    const ours = job !== undefined && job.worker === worker;

    if (data.type === "progress") {
      if (ours) {
        job.compressed = data.compressed;
        job.nar = data.nar;
        this.onEvent(FetchEvent.PROGRESS, job);
      }
      return;
    }
    if (data.type === "retry") {
      if (ours) {
        job.compressed = 0;
        job.nar = 0;
        this.onEvent(FetchEvent.RETRY, job, data);
      }
      return;
    }

    // Done or failed: the worker is free again.
    this.idle.push(worker);
    if (ours) {
      this.jobs.delete(data.key);
      this.reserved -= job.reserve;
      if (data.type === "done") {
        this.sessionBytes += data.compressedBytes;
        if (data.rawStored !== null) {
          this.remember(job.narHash, storedBytes(job.narSize), Date.now());
        }
        this.onEvent(FetchEvent.DONE, job, data);
      } else {
        this.onEvent(
          data.aborted ? FetchEvent.DROPPED : FetchEvent.FAILED,
          job,
          data,
        );
      }
    }
    this.pump();
  }

  remember(narHash, bytes, lastUsed) {
    if (this.stored.has(narHash)) {
      return;
    }
    this.stored.set(narHash, { bytes, lastUsed });
    this.storedTotal += bytes;
  }

  touch(hashes, now = Date.now()) {
    for (const hash of hashes) {
      const entry = this.stored.get(hash);
      if (entry !== undefined) {
        entry.lastUsed = now;
      }
    }
  }

  evict(narHash) {
    const entry = this.stored.get(narHash);
    if (entry === undefined) {
      return;
    }
    this.stored.delete(narHash);
    this.storedTotal -= entry.bytes;
    this.onEvent(FetchEvent.EVICT, { narHash });
  }

  // Evict least recently used NARs outside `protectedHashes` until `need`
  // more bytes fit. False when they cannot, and the NAR is then fetched
  // for its summaries only.
  makeRoom(need, protectedHashes) {
    if (need > this.budget) {
      return false;
    }
    const over = () => this.storedTotal + this.reserved + need > this.budget;
    if (!over()) {
      return true;
    }
    const victims = [...this.stored.entries()]
      .filter(([hash]) => !protectedHashes.has(hash))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [hash] of victims) {
      if (!over()) {
        break;
      }
      this.evict(hash);
    }
    return !over();
  }

  get loading() {
    return [...this.jobs.values()].filter((job) => job.worker !== null).length;
  }

  get queued() {
    return [...this.jobs.values()].filter((job) => job.worker === null).length;
  }

  get explicitPending() {
    return [...this.jobs.values()].some((job) => job.explicit);
  }
}
