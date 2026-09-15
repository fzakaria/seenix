// Tests the tile arithmetic against brute force over small worlds: a
// tile's byte range is exactly the curve indices of its pixels, the LOD
// follows the zoom and is clamped, an ancestor's texel rectangle covers
// the child, and contentBounds is the bounding box of the pixels whose
// curve index falls before the closure's last byte.
import { test } from "node:test";
import assert from "node:assert/strict";

import { xy2d } from "../../site/js/hilbert.js";
import {
  ancestorOf,
  contentBounds,
  lodFor,
  tileByteRange,
} from "../../site/js/tilemath.js";

const ORDER = 10;

test("a tile's byte range is the curve indices of its pixels", () => {
  const k = 1;
  const size = 2 ** (8 + k);
  for (const [tx, ty] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    let min = Infinity;
    let max = -Infinity;
    for (let y = ty * size; y < (ty + 1) * size; y += 7) {
      for (let x = tx * size; x < (tx + 1) * size; x += 7) {
        const d = xy2d(ORDER, x, y);
        min = Math.min(min, d);
        max = Math.max(max, d);
      }
    }
    const [start, end] = tileByteRange(ORDER, k, tx, ty);
    assert.ok(min >= start && max < end, `${tx},${ty}`);
  }
});

test("the LOD follows the zoom and stays within the world", () => {
  assert.equal(lodFor(0, ORDER), 0);
  assert.equal(lodFor(-1, ORDER), 1);
  assert.equal(lodFor(-20, ORDER), 2);
  assert.equal(lodFor(3, ORDER), 0);
});

test("an ancestor's texel rectangle is where the child sits", () => {
  assert.deepEqual(ancestorOf(0, 3, 2, 1), {
    k: 1,
    tx: 1,
    ty: 1,
    uv: [128, 0, 256, 128],
  });
});

test("contentBounds is the bounding box of the bytes before the end", () => {
  const order = 4;
  const side = 2 ** order;
  for (const total of [1, 5, 16, 17, 100, 200, 255, 256]) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        if (xy2d(order, x, y) >= total) {
          continue;
        }
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    }
    assert.deepEqual(
      contentBounds(order, total),
      { x0, y0, x1, y1 },
      `total ${total}`,
    );
  }
});
