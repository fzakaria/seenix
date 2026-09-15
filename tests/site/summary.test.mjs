// Tests the byte summaries on patterns whose records are known in
// advance: all zeros, all printable ASCII, and every byte value equally
// often (full entropy). Records must not depend on how the stream is
// chunked, a short final chunk is normalised by its own length, and both
// granularities are produced from one pass.
import { test } from "node:test";
import assert from "node:assert/strict";

import { COARSE_CHUNK, FINE_CHUNK } from "../../site/js/config.js";
import {
  Field,
  SummaryBuilder,
  controlFraction,
} from "../../site/js/summary.js";

const MAX = 255;

function summarize(bytes, split = bytes.length) {
  const builder = new SummaryBuilder();
  for (let at = 0; at < bytes.length; at += split) {
    builder.push(bytes.subarray(at, at + split));
  }
  return builder.finish();
}

const record = (summary, i) => [...summary.subarray(i * 4, i * 4 + 4)];

test("all zeros: zero fraction full, entropy none", () => {
  const { coarse, fine } = summarize(new Uint8Array(COARSE_CHUNK));
  assert.deepEqual(record(coarse, 0), [MAX, 0, 0, 0]);
  assert.equal(fine.length, (COARSE_CHUNK / FINE_CHUNK) * 4);
  assert.deepEqual(record(fine, 15), [MAX, 0, 0, 0]);
});

test("printable ASCII: ascii fraction full", () => {
  const text = new TextEncoder().encode("hello world\n".repeat(400));
  const { coarse } = summarize(text.subarray(0, COARSE_CHUNK));
  const [zero, ascii, high] = record(coarse, 0);
  assert.deepEqual([zero, ascii, high], [0, MAX, 0]);
  assert.equal(controlFraction(coarse, 0), 0);
});

test("every byte value equally often: full entropy and exact class shares", () => {
  const bytes = new Uint8Array(COARSE_CHUNK);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = i % 256;
  }
  const { coarse, fine } = summarize(bytes);

  // 1 zero, 95 printable plus tab, newline and return, 128 high bytes.
  assert.equal(coarse[Field.ZERO], Math.round((1 / 256) * MAX));
  assert.equal(coarse[Field.ASCII], Math.round((98 / 256) * MAX));
  assert.equal(coarse[Field.HIGH], Math.round((128 / 256) * MAX));
  assert.equal(coarse[Field.ENTROPY], MAX);

  // Each 256-byte fine chunk holds every value once: full entropy too.
  assert.equal(fine[Field.ENTROPY], MAX);
});

test("records do not depend on chunking", () => {
  const bytes = new Uint8Array(3 * COARSE_CHUNK + 100);
  let state = 7;
  for (let i = 0; i < bytes.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    bytes[i] = i % 3 === 0 ? 0 : state & 0xff;
  }
  const whole = summarize(bytes);
  for (const split of [1, 7, 255, 4097]) {
    const parts = summarize(bytes, split);
    assert.deepEqual(parts.coarse, whole.coarse, `split ${split}`);
    assert.deepEqual(parts.fine, whole.fine, `split ${split}`);
  }
});

test("a short final chunk is normalised by its own length", () => {
  const bytes = new Uint8Array(COARSE_CHUNK + 10);
  const { coarse, fine } = summarize(bytes);
  assert.equal(coarse.length, 2 * 4);
  assert.deepEqual(record(coarse, 1), [MAX, 0, 0, 0]);
  assert.equal(fine.length, Math.ceil(bytes.length / FINE_CHUNK) * 4);
});
