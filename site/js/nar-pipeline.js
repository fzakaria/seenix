// One NAR, from response body to everything the map needs, in a single
// pass:
//
//   body -> count compressed bytes -> decode (xz | zstd | bzip2 | none)
//        -> sha256, summaries, file index, reference scan, and the sink
//
// Nothing holds the whole archive: every stage takes chunks as they come,
// so memory is bounded by chunk sizes. At the end the byte count is held
// to NarSize and the hash to NarHash, the two fields a cache signs.

import xzwasm from "../vendor/xzwasm.js";
import fzstd from "../vendor/fzstd.js";
import { createSHA256 } from "../vendor/hash-wasm.js";
import { parseHash, sameBytes } from "./hash.js";
import { NarIndexer } from "./narindex.js";
import { RefScanner } from "./refscan.js";
import { SummaryBuilder } from "./summary.js";

export const Compression = Object.freeze({
  XZ: "xz",
  ZSTD: "zstd",
  BZIP2: "bzip2",
  NONE: "none",
});

// Why a NAR was refused. The fetcher retries SIZE, HASH, DECODE and
// ARCHIVE once from a fresh download; the others would fail the same way
// again.
export const Failure = Object.freeze({
  UNSUPPORTED: "unsupported",
  DECODER_UNAVAILABLE: "decoder-unavailable",
  DECODE: "decode",
  SIZE: "size",
  HASH: "hash",
  ARCHIVE: "archive",
});

export const RETRYABLE = new Set([
  Failure.DECODE,
  Failure.SIZE,
  Failure.HASH,
  Failure.ARCHIVE,
]);

export class NarError extends Error {
  constructor(failure, message) {
    super(message);
    this.failure = failure;
  }
}

// How much of a bzip2 archive is handed to the decoder at a time. The
// decoder returns the blocks that finished within a push, so the piece
// size bounds how much of the unpacked archive exists inside wasm at
// once.
const BZIP2_PIECE = 256 * 1024;

// The bzip2 decoder is wasm, loaded the first time a path needs it. A
// failed load clears the promise so the next path tries again.
let bzip2Promise;

function loadBzip2() {
  bzip2Promise ??= import("../vendor/crabz2.js")
    .then(async (module) => {
      await module.default();
      return module;
    })
    .catch((err) => {
      bzip2Promise = undefined;
      throw new NarError(
        Failure.DECODER_UNAVAILABLE,
        `the bzip2 decoder could not be loaded: ${err.message}`,
      );
    });
  return bzip2Promise;
}

// The decompressed stream for a compressed one.
async function decode(stream, compression) {
  if (compression === Compression.NONE) {
    return stream;
  }

  if (compression === Compression.XZ) {
    return new xzwasm.XzReadableStream(stream);
  }

  // fzstd's output chunks may be views into its window, which the next
  // push overwrites, so each one is copied before it is queued.
  if (compression === Compression.ZSTD) {
    let decompressor;
    return stream.pipeThrough(
      new TransformStream({
        start(controller) {
          decompressor = new fzstd.Decompress((chunk) => {
            if (chunk.length > 0) {
              controller.enqueue(chunk.slice());
            }
          });
        },
        transform(chunk) {
          decompressor.push(chunk);
        },
        flush() {
          decompressor.push(new Uint8Array(0), true);
        },
      }),
    );
  }

  // bzip2: push in bounded pieces, and free the decoder's wasm buffers as
  // soon as the stream ends either way.
  const module = await loadBzip2();
  const decoder = new module.Bz2Decoder();
  let freed = false;
  const free = () => {
    if (!freed) {
      freed = true;
      decoder.free();
    }
  };
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        try {
          for (let at = 0; at < chunk.length; at += BZIP2_PIECE) {
            const part = decoder.push(chunk.subarray(at, at + BZIP2_PIECE));
            if (part.length > 0) {
              controller.enqueue(part);
            }
          }
        } catch (err) {
          free();
          throw err;
        }
      },
      flush(controller) {
        try {
          const part = decoder.finish();
          if (part.length > 0) {
            controller.enqueue(part);
          }
        } finally {
          free();
        }
      },
    }),
  );
}

// Stream one NAR through every stage.
//
//   body         ReadableStream of compressed bytes
//   compression  a Compression value
//   narSize      the signed unpacked size
//   narHash      the signed hash, or null when unknown
//   digests      Map of digest -> path id, for the reference scan
//   sink         optional; hears every decoded chunk, in order
//   onProgress   optional; hears (compressedBytes, narBytes)
//
// Resolves to { compressedBytes, narBytes, summary, index, refs } or
// rejects with a NarError.
export async function processNar({
  body,
  compression,
  narSize,
  narHash,
  digests,
  sink = null,
  onProgress = null,
}) {
  if (!Object.values(Compression).includes(compression)) {
    throw new NarError(
      Failure.UNSUPPORTED,
      `unsupported NAR compression "${compression}"`,
    );
  }

  const expected = narHash ? parseHash(narHash) : null;
  const hasher = await createSHA256();
  hasher.init();
  const summary = new SummaryBuilder(narSize);
  const indexer = new NarIndexer();
  const scanner = new RefScanner(digests);

  // Count compressed bytes on the way into the decoder.
  let compressedBytes = 0;
  const counted = body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        compressedBytes += chunk.length;
        controller.enqueue(chunk);
      },
    }),
  );

  const decoded = await decode(counted, compression);
  const reader = decoded.getReader();
  let narBytes = 0;

  try {
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (err) {
        throw new NarError(
          Failure.DECODE,
          `${compression} decode failed: ${err.message}`,
        );
      }
      if (step.done) {
        break;
      }

      const chunk = step.value;
      narBytes += chunk.length;
      if (narBytes > narSize) {
        throw new NarError(
          Failure.SIZE,
          `unpacked to more than ${narSize} bytes, narinfo says ${narSize}`,
        );
      }

      hasher.update(chunk);
      summary.push(chunk);
      scanner.push(chunk);
      try {
        indexer.push(chunk);
      } catch (err) {
        throw new NarError(Failure.ARCHIVE, err.message);
      }
      sink?.(chunk);
      onProgress?.(compressedBytes, narBytes);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }

  // The two signed facts, then the archive's own structure.
  if (narBytes !== narSize) {
    throw new NarError(
      Failure.SIZE,
      `unpacked to ${narBytes} bytes, narinfo says ${narSize}`,
    );
  }
  if (
    expected !== null &&
    !sameBytes(hasher.digest("binary"), expected.bytes)
  ) {
    throw new NarError(
      Failure.HASH,
      "unpacked archive's sha256 does not match the narinfo",
    );
  }
  let index;
  try {
    index = indexer.finish();
  } catch (err) {
    throw new NarError(Failure.ARCHIVE, err.message);
  }

  return {
    compressedBytes,
    narBytes,
    summary: summary.finish(),
    index,
    refs: scanner.finish(),
  };
}
