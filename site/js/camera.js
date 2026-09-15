// The view onto the world: a centre in world pixels and a zoom, the log2
// of device pixels per world pixel. Positions from pointer events are CSS
// pixels relative to the canvas.

// Deepest zoom: 64 device pixels per byte.
export const MAX_ZOOM = 6;

// How far past "whole world fits" the view may zoom out.
const ZOOM_OUT_MARGIN = 2;

// The share of the viewport the fitted rectangle fills.
const FIT_FILL = 0.94;

const FLY_MS = 650;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

export class Camera {
  constructor() {
    this.cx = 0;
    this.cy = 0;
    this.zoom = 0;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.worldSize = 256;
    this.flight = null;
  }

  resize(cssWidth, cssHeight, dpr) {
    this.dpr = dpr;
    this.width = Math.max(1, Math.round(cssWidth * dpr));
    this.height = Math.max(1, Math.round(cssHeight * dpr));
  }

  get scale() {
    return 2 ** this.zoom;
  }

  fitZoom() {
    const side = Math.min(this.width, this.height) * FIT_FILL;
    return Math.log2(side / this.worldSize);
  }

  clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(this.fitZoom() - ZOOM_OUT_MARGIN, zoom));
  }

  // Centre and zoom on a world rectangle, the whole world by default.
  fit(bounds = { x0: 0, y0: 0, x1: this.worldSize, y1: this.worldSize }) {
    const width = Math.max(1, bounds.x1 - bounds.x0);
    const height = Math.max(1, bounds.y1 - bounds.y0);
    this.cx = (bounds.x0 + bounds.x1) / 2;
    this.cy = (bounds.y0 + bounds.y1) / 2;
    this.zoom = this.clampZoom(
      Math.log2(Math.min(this.width / width, this.height / height) * FIT_FILL),
    );
    this.flight = null;
  }

  toWorld(cssX, cssY) {
    const s = this.scale;
    return [
      this.cx + (cssX * this.dpr - this.width / 2) / s,
      this.cy + (cssY * this.dpr - this.height / 2) / s,
    ];
  }

  // Device pixels.
  toDevice(wx, wy) {
    const s = this.scale;
    return [
      (wx - this.cx) * s + this.width / 2,
      (wy - this.cy) * s + this.height / 2,
    ];
  }

  viewRect() {
    const halfWidth = this.width / 2 / this.scale;
    const halfHeight = this.height / 2 / this.scale;
    return {
      x0: this.cx - halfWidth,
      y0: this.cy - halfHeight,
      x1: this.cx + halfWidth,
      y1: this.cy + halfHeight,
    };
  }

  clampCenter() {
    this.cx = Math.min(this.worldSize, Math.max(0, this.cx));
    this.cy = Math.min(this.worldSize, Math.max(0, this.cy));
  }

  // Zoom by `delta` doublings, keeping the world point under the cursor
  // where it is.
  zoomAround(cssX, cssY, delta) {
    const [wx, wy] = this.toWorld(cssX, cssY);
    this.zoom = this.clampZoom(this.zoom + delta);
    const s = this.scale;
    this.cx = wx - (cssX * this.dpr - this.width / 2) / s;
    this.cy = wy - (cssY * this.dpr - this.height / 2) / s;
    this.clampCenter();
    this.flight = null;
  }

  panBy(dxCss, dyCss) {
    this.cx -= (dxCss * this.dpr) / this.scale;
    this.cy -= (dyCss * this.dpr) / this.scale;
    this.clampCenter();
    this.flight = null;
  }

  set(cx, cy, zoom) {
    this.cx = cx;
    this.cy = cy;
    this.zoom = this.clampZoom(zoom);
    this.clampCenter();
    this.flight = null;
  }

  // Start a flight. Long flights pull out mid-way so the reader sees
  // where the view is going.
  flyTo(cx, cy, zoom, now) {
    this.flight = {
      from: { cx: this.cx, cy: this.cy, zoom: this.zoom },
      to: { cx, cy, zoom: this.clampZoom(zoom) },
      start: now,
    };
  }

  // Advance a flight; true while one is under way.
  step(now) {
    if (this.flight === null) {
      return false;
    }
    const { from, to, start } = this.flight;
    const t = Math.min(1, (now - start) / FLY_MS);
    const e = ease(t);

    const distance = Math.hypot(to.cx - from.cx, to.cy - from.cy) * this.scale;
    const lowest = Math.min(from.zoom, to.zoom);
    const pullOut = Math.log2(
      Math.max(1, distance / Math.min(this.width, this.height)),
    );
    this.zoom = lerp(from.zoom, to.zoom, e) - pullOut * Math.sin(Math.PI * e);
    this.zoom = Math.max(this.zoom, Math.min(lowest, this.fitZoom()));
    this.cx = lerp(from.cx, to.cx, e);
    this.cy = lerp(from.cy, to.cy, e);

    if (t >= 1) {
      this.set(to.cx, to.cy, to.zoom);
      return false;
    }
    return true;
  }
}
