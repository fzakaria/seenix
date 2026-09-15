// Which tiles to draw, which to ask the tile worker for, and which to
// forget. A tile that is not ready is covered by the nearest coarser tile
// that is, scaled up, so panning never shows empty space.

import { CPU_TILE_CACHE, GPU_TILE_CACHE, TILE_SIZE } from "./config.js";
import { HAS_BYTES } from "./tileformat.js";
import {
  ancestorOf,
  lodFor,
  maxLod,
  overlaps,
  tileByteRange,
  tileKey,
  tileWorldSize,
  visibleTiles,
} from "./tilemath.js";

const MAX_IN_FLIGHT = 6;
const MAX_FALLBACK_LEVELS = 8;
const FULL_UV = [0, 0, TILE_SIZE, TILE_SIZE];

export class TileManager {
  constructor(renderer, worker, onChange) {
    this.renderer = renderer;
    this.worker = worker;
    this.onChange = onChange;
    this.onTop = null;
    this.cache = new Map();
    this.inFlight = new Map();
    this.wanted = [];
    this.cpu = new Map();
    this.topIds = null;
    this.generation = -1;
    this.order = TILE_SIZE;
    this.total = 0;
    this.frameNo = 0;

    worker.addEventListener("message", ({ data }) => {
      if (data.type === "tile") {
        this.receive(data);
      }
    });
  }

  reset(generation, order, total) {
    for (const entry of this.cache.values()) {
      this.renderer.deleteTile(entry.textures);
    }
    this.cache.clear();
    this.inFlight.clear();
    this.cpu.clear();
    this.wanted = [];
    this.topIds = null;
    this.generation = generation;
    this.order = order;
    this.total = total;
  }

  deviceRect(camera, k, tx, ty) {
    const size = tileWorldSize(k);
    const [x0, y0] = camera.toDevice(tx * size, ty * size);
    const [x1, y1] = camera.toDevice((tx + 1) * size, (ty + 1) * size);
    return [x0, y0, x1, y1];
  }

  // The draw list for this frame, and the requests it implies.
  frame(camera) {
    this.frameNo += 1;
    const order = this.order;
    const top = maxLod(order);
    const k = lodFor(camera.zoom, order);
    const items = [];
    this.wanted = [];

    // The whole world at the coarsest LOD underneath everything, while it
    // is not so magnified that its rectangle loses precision.
    const topKey = tileKey(top, 0, 0);
    const topEntry = this.cache.get(topKey);
    if (topEntry === undefined || topEntry.stale) {
      this.want(top, 0, 0, -1);
    }
    if (topEntry !== undefined && top - k <= MAX_FALLBACK_LEVELS) {
      topEntry.lastUsed = this.frameNo;
      items.push(
        this.item(topEntry, this.deviceRect(camera, top, 0, 0), FULL_UV),
      );
    }

    for (const { tx, ty } of visibleTiles(camera.viewRect(), order, k)) {
      const rect = this.deviceRect(camera, k, tx, ty);
      const [start] = tileByteRange(order, k, tx, ty);
      if (start >= this.total) {
        continue;
      }

      const entry = this.cache.get(tileKey(k, tx, ty));
      if (entry === undefined || entry.stale) {
        const cx = (rect[0] + rect[2]) / 2 - camera.width / 2;
        const cy = (rect[1] + rect[3]) / 2 - camera.height / 2;
        this.want(k, tx, ty, Math.hypot(cx, cy));
      }
      if (entry !== undefined) {
        entry.lastUsed = this.frameNo;
        items.push(this.item(entry, rect, FULL_UV));
        continue;
      }

      // Fall back to the nearest coarser tile that is ready.
      for (
        let levels = 1;
        levels <= MAX_FALLBACK_LEVELS && k + levels < top;
        levels += 1
      ) {
        const a = ancestorOf(k, tx, ty, levels);
        const ancestor = this.cache.get(tileKey(a.k, a.tx, a.ty));
        if (ancestor === undefined) {
          continue;
        }
        ancestor.lastUsed = this.frameNo;
        items.push(this.item(ancestor, rect, a.uv));
        break;
      }
    }

    this.pump();
    this.evict();
    return items;
  }

  item(entry, rect, uv) {
    return { textures: entry.textures, k: entry.k, rect, uv };
  }

  want(k, tx, ty, priority) {
    const key = tileKey(k, tx, ty);
    const flight = this.inFlight.get(key);
    if (flight !== undefined && !flight.stale) {
      return;
    }
    this.wanted.push({ key, k, tx, ty, priority });
  }

  pump() {
    this.wanted.sort((a, b) => a.priority - b.priority);
    for (const request of this.wanted) {
      if (this.inFlight.size >= MAX_IN_FLIGHT) {
        return;
      }
      if (this.inFlight.has(request.key)) {
        continue;
      }
      const [start, end] = tileByteRange(
        this.order,
        request.k,
        request.tx,
        request.ty,
      );
      this.inFlight.set(request.key, { start, end, stale: false });
      this.worker.postMessage({
        type: "build",
        generation: this.generation,
        key: request.key,
        k: request.k,
        tx: request.tx,
        ty: request.ty,
      });
    }
  }

  receive(message) {
    if (message.generation !== this.generation) {
      return;
    }
    const flight = this.inFlight.get(message.key);
    this.inFlight.delete(message.key);

    const old = this.cache.get(message.key);
    if (old !== undefined) {
      this.renderer.deleteTile(old.textures);
    }
    const [start, end] = tileByteRange(
      this.order,
      message.k,
      message.tx,
      message.ty,
    );
    this.cache.set(message.key, {
      k: message.k,
      tx: message.tx,
      ty: message.ty,
      start,
      end,
      textures: this.renderer.uploadTile(message.data, message.ids, TILE_SIZE),
      stale: flight?.stale ?? false,
      lastUsed: this.frameNo,
    });

    // LOD-0 tiles keep their bytes for the hex overlay.
    if (message.k === 0) {
      this.cpu.delete(message.key);
      this.cpu.set(message.key, { data: message.data, ids: message.ids });
      while (this.cpu.size > CPU_TILE_CACHE) {
        this.cpu.delete(this.cpu.keys().next().value);
      }
    }
    if (message.k === maxLod(this.order)) {
      this.topIds = message.ids;
      this.onTop?.(message.ids);
    }
    this.onChange();
  }

  // Forget the least recently drawn tiles over the budget.
  evict() {
    if (this.cache.size <= GPU_TILE_CACHE) {
      return;
    }
    const topKey = tileKey(maxLod(this.order), 0, 0);
    const victims = [...this.cache.entries()]
      .filter(
        ([key, entry]) => entry.lastUsed !== this.frameNo && key !== topKey,
      )
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of victims) {
      if (this.cache.size <= GPU_TILE_CACHE) {
        return;
      }
      this.renderer.deleteTile(entry.textures);
      this.cache.delete(key);
    }
  }

  // Tiles covering bytes [start, end) are rebuilt when next drawn; until
  // then the old texture stays on screen.
  invalidate(start, end) {
    for (const entry of this.cache.values()) {
      if (overlaps(start, end, entry.start, entry.end)) {
        entry.stale = true;
      }
    }
    for (const flight of this.inFlight.values()) {
      if (overlaps(start, end, flight.start, flight.end)) {
        flight.stale = true;
      }
    }
  }

  // The byte at world pixel (x, y), when a LOD-0 tile holding it is in
  // memory and was built from bytes; otherwise null.
  byteAt(x, y) {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    const held = this.cpu.get(tileKey(0, tx, ty));
    if (held === undefined) {
      return null;
    }
    const i = (y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE);
    if ((held.ids[2 * i + 1] & HAS_BYTES) === 0) {
      return null;
    }
    return held.data[4 * i];
  }
}
