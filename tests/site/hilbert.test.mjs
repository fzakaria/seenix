// Tests the Hilbert curve the layout rests on: xy2d and d2xy are inverse
// bijections, consecutive indices are neighbouring pixels, and every
// aligned 2^m block is one contiguous curve range whose block position is
// d2xy of the range's index at the reduced order. Exhaustive at order 6,
// sampled at order 18 where indices pass 2^32.
import { test } from "node:test";
import assert from "node:assert/strict";

import { d2xy, xy2d } from "../../site/js/hilbert.js";

const SMALL_ORDER = 6;
const LARGE_ORDER = 18;
const SAMPLES = 100_000;

test("xy2d and d2xy round-trip every pixel at order 6", () => {
  const n = 2 ** SMALL_ORDER;
  const seen = new Set();
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const d = xy2d(SMALL_ORDER, x, y);
      assert.ok(d >= 0 && d < n * n);
      seen.add(d);
      assert.deepEqual(d2xy(SMALL_ORDER, d), [x, y]);
    }
  }
  assert.equal(seen.size, n * n);
});

test("consecutive curve indices are adjacent pixels", () => {
  const n = 2 ** SMALL_ORDER;
  let [px, py] = d2xy(SMALL_ORDER, 0);
  for (let d = 1; d < n * n; d += 1) {
    const [x, y] = d2xy(SMALL_ORDER, d);
    assert.equal(Math.abs(x - px) + Math.abs(y - py), 1);
    [px, py] = [x, y];
  }
});

test("an aligned block is one contiguous range keyed by d2xy", () => {
  for (let m = 1; m < SMALL_ORDER; m += 1) {
    const side = 2 ** m;
    const blocks = 2 ** (SMALL_ORDER - m);
    for (let by = 0; by < blocks; by += 1) {
      for (let bx = 0; bx < blocks; bx += 1) {
        let min = Infinity;
        let max = -Infinity;
        for (let y = by * side; y < (by + 1) * side; y += 1) {
          for (let x = bx * side; x < (bx + 1) * side; x += 1) {
            const d = xy2d(SMALL_ORDER, x, y);
            min = Math.min(min, d);
            max = Math.max(max, d);
          }
        }
        const span = 4 ** m;
        assert.equal(max - min + 1, span);
        assert.equal(min % span, 0);
        const q = min / span;
        assert.deepEqual(d2xy(SMALL_ORDER - m, q), [bx, by]);
      }
    }
  }
});

test("round-trips random points at order 18, past 2^32", () => {
  const n = 2 ** LARGE_ORDER;
  let state = 1;
  const random = () => {
    // A fixed LCG, so a failure reproduces.
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  let sawLarge = false;
  for (let i = 0; i < SAMPLES; i += 1) {
    const x = Math.floor(random() * n);
    const y = Math.floor(random() * n);
    const d = xy2d(LARGE_ORDER, x, y);
    sawLarge ||= d > 2 ** 32;
    assert.deepEqual(d2xy(LARGE_ORDER, d), [x, y]);
  }
  assert.ok(sawLarge);
});
