// Tile arithmetic. A tile at LOD k is 256 texels square, each texel 2^k
// world pixels square, so the tile covers 4^(8+k) bytes: one contiguous
// range of the curve, found by xy2d at the reduced order.

import { TILE_ORDER, TILE_SIZE } from "./config.js";
import { xy2d } from "./hilbert.js";

export const tileKey = (k, tx, ty) => `${k}/${tx}/${ty}`;

// The coarsest LOD: one tile covering the whole world.
export const maxLod = (order) => order - TILE_ORDER;

export const tileWorldSize = (k) => TILE_SIZE * 2 ** k;

export const tilesPerSide = (order, k) => 2 ** (order - TILE_ORDER - k);

// The LOD whose texels are closest to one device pixel at `zoom`, which
// is log2 of device pixels per world pixel.
export function lodFor(zoom, order) {
  return Math.min(maxLod(order), Math.max(0, Math.round(-zoom)));
}

// [start, end) in bytes.
export function tileByteRange(order, k, tx, ty) {
  const span = 4 ** (TILE_ORDER + k);
  const q = xy2d(order - TILE_ORDER - k, tx, ty);
  return [q * span, q * span + span];
}

// The tiles at LOD k that intersect a world rectangle.
export function visibleTiles(rect, order, k) {
  const size = tileWorldSize(k);
  const side = tilesPerSide(order, k);
  const world = side * size;
  if (rect.x1 <= 0 || rect.y1 <= 0 || rect.x0 >= world || rect.y0 >= world) {
    return [];
  }

  const first = (v) => Math.max(0, Math.floor(v / size));
  const last = (v) => Math.min(side - 1, Math.ceil(v / size) - 1);
  const tiles = [];
  for (let ty = first(rect.y0); ty <= last(rect.y1); ty += 1) {
    for (let tx = first(rect.x0); tx <= last(rect.x1); tx += 1) {
      tiles.push({ tx, ty });
    }
  }
  return tiles;
}

// The tile `levels` LODs coarser that contains tile (k, tx, ty), with the
// texel rectangle inside it the finer tile corresponds to.
export function ancestorOf(k, tx, ty, levels) {
  const scale = 2 ** levels;
  const ax = Math.floor(tx / scale);
  const ay = Math.floor(ty / scale);
  const texels = TILE_SIZE / scale;
  const u0 = (tx - ax * scale) * texels;
  const v0 = (ty - ay * scale) * texels;
  return {
    k: k + levels,
    tx: ax,
    ty: ay,
    uv: [u0, v0, u0 + texels, v0 + texels],
  };
}

export const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
