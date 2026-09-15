// The map: the canvas, the camera, the tiles, and every way of moving
// around (drag, wheel, pinch, double-tap, keys, the minimap). What a
// position means is the page's business; the map reports world
// coordinates through its callbacks.

import { Camera } from "./camera.js";
import { Renderer } from "./render.js";
import { NO_PATH } from "./tileformat.js";
import { TileManager } from "./tiles.js";
import { contentBounds, maxLod } from "./tilemath.js";
import { Mode } from "./url.js";

// Hex digits are drawn once a byte is this many CSS pixels wide.
const HEX_MIN_CSS_PX = 12;
const HEX_MAX_CELLS = 8000;

// A pointer that moves less than this between down and up is a click.
const DRAG_THRESHOLD_PX = 6;
const DOUBLE_TAP_MS = 320;
const WHEEL_ZOOM_PER_PIXEL = 1 / 360;

// A trackpad pinch arrives as a wheel event with ctrlKey set and deltas of
// a few pixels, so it zooms more per pixel than a scroll does.
const PINCH_ZOOM_PER_PIXEL = 1 / 100;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;
const KEY_PAN_FRACTION = 0.2;
const KEY_ZOOM_STEP = 0.5;
const DOUBLE_CLICK_ZOOM = 1;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export class MapView {
  constructor(elements, tileWorker, callbacks) {
    this.el = elements;
    this.callbacks = callbacks;
    this.camera = new Camera();
    this.renderer = new Renderer(elements.canvas);
    this.tiles = new TileManager(this.renderer, tileWorker, () =>
      this.requestFrame(),
    );

    this.model = null;
    this.mode = Mode.BYTES;
    this.hovered = NO_PATH;
    this.hoveredFile = 0;
    this.selected = NO_PATH;
    this.refLine = null;
    this.background = [0, 0, 0];
    this.pathTable = null;
    this.pathTableRows = 1;
    this.pathTableDirty = false;
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.pending = false;
    this.pointers = new Map();
    this.gesture = null;
    this.lastTap = null;
    this.hoverPoint = null;
    this.hoverScheduled = false;

    new ResizeObserver(() => this.resize()).observe(elements.shell);
    this.resize();
    this.listen();
  }

  resize() {
    const { shell, canvas, overlay, minimap } = this.el;
    const dpr = window.devicePixelRatio || 1;
    const hadSize = this.camera.width > 1;
    const before = hadSize ? this.camera.viewRect() : null;
    this.camera.resize(shell.clientWidth, shell.clientHeight, dpr);
    this.renderer.resize(this.camera.width, this.camera.height);
    overlay.width = this.camera.width;
    overlay.height = this.camera.height;
    minimap.width = Math.round(minimap.clientWidth * dpr);
    minimap.height = Math.round(minimap.clientHeight * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    if (before !== null && this.model !== null) {
      this.camera.clampCenter();
    }
    this.requestFrame();
  }

  setModel(model, generation, view) {
    this.model = model;
    this.hovered = NO_PATH;
    this.selected = NO_PATH;
    this.refLine = null;
    this.camera.worldSize = 2 ** model.order;
    this.bounds = contentBounds(model.order, model.total);
    this.tiles.reset(generation, model.order, model.total);
    if (view === null) {
      this.camera.fit(this.bounds);
    } else {
      this.camera.set(view.cx, view.cy, view.zoom);
    }
    this.requestFrame();
  }

  setPathTable(bytes, rows) {
    this.pathTable = bytes;
    this.pathTableRows = rows;
    this.pathTableDirty = true;
    this.requestFrame();
  }

  setMode(mode) {
    this.mode = mode;
    this.requestFrame();
  }

  setHover(id, file, refLine) {
    this.hovered = id;
    this.hoveredFile = file;
    this.refLine = refLine;
    this.requestFrame();
  }

  setSelected(id) {
    this.selected = id < 0 ? NO_PATH : id;
    this.requestFrame();
  }

  setBackground(rgb) {
    this.background = rgb;
    this.requestFrame();
  }

  invalidate(start, end) {
    this.tiles.invalidate(start, end);
    this.requestFrame();
  }

  flyTo(cx, cy, zoom) {
    this.camera.flyTo(cx, cy, zoom, performance.now());
    this.requestFrame();
  }

  // Frame the bytes of the closure, not the padding around them.
  fit() {
    this.camera.fit(this.bounds);
    this.requestFrame();
  }

  view() {
    const { cx, cy, zoom } = this.camera;
    return { cx, cy, zoom };
  }

  requestFrame() {
    if (this.pending) {
      return;
    }
    this.pending = true;
    requestAnimationFrame((now) => this.frame(now));
  }

  frame(now) {
    this.pending = false;
    if (this.pathTableDirty && this.pathTable !== null) {
      this.renderer.setPathTable(this.pathTable, this.pathTableRows);
      this.pathTableDirty = false;
    }
    if (this.model === null) {
      this.renderer.draw([], this.uniforms());
      return;
    }

    const flying = this.camera.step(now);
    const items = this.tiles.frame(this.camera);

    // The minimap is the coarsest tile drawn again, by the same shader, into
    // the corner of the canvas under the minimap element, so it shows the
    // same mode, bytes, hatching and highlighting as the map.
    const minimap = this.tiles.topItem(this.minimapRect());
    if (minimap !== null) {
      items.push(minimap);
    }
    this.renderer.draw(items, this.uniforms());
    this.drawOverlay();
    this.drawMinimap();
    this.callbacks.onView?.();
    if (flying) {
      this.requestFrame();
    }
  }

  uniforms() {
    return {
      mode: this.mode,
      hovered: this.hovered,
      selected: this.selected,
      hoveredFile: this.hoveredFile,
      background: this.background,
      dpr: this.camera.dpr,
    };
  }

  // PNG of the current view at canvas resolution. The frame is drawn and
  // read in the same task, before the browser clears the buffer.
  snapshot() {
    this.pending = false;
    const items = this.tiles.frame(this.camera);
    this.renderer.draw(items, this.uniforms());
    return new Promise((resolve) =>
      this.el.canvas.toBlob(resolve, "image/png"),
    );
  }

  // Hex digits over bytes at deep zoom, and the line from a hovered store
  // path string to the path it names.
  drawOverlay() {
    const ctx = this.el.overlay.getContext("2d");
    const camera = this.camera;
    ctx.clearRect(0, 0, camera.width, camera.height);

    const cell = camera.scale;
    if (cell >= HEX_MIN_CSS_PX * camera.dpr) {
      const rect = camera.viewRect();
      const x0 = Math.max(0, Math.floor(rect.x0));
      const y0 = Math.max(0, Math.floor(rect.y0));
      const x1 = Math.min(camera.worldSize, Math.ceil(rect.x1));
      const y1 = Math.min(camera.worldSize, Math.ceil(rect.y1));
      if ((x1 - x0) * (y1 - y0) <= HEX_MAX_CELLS) {
        ctx.font = `${Math.round(Math.min(cell * 0.42, 22 * camera.dpr))}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(1, camera.dpr * 1.5);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
        ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const byte = this.tiles.byteAt(x, y);
            if (byte === null) {
              continue;
            }
            const [dx, dy] = camera.toDevice(x + 0.5, y + 0.5);
            const text = byte.toString(16).padStart(2, "0");
            ctx.strokeText(text, dx, dy);
            ctx.fillText(text, dx, dy);
          }
        }
      }
    }

    if (this.refLine !== null) {
      const [fx, fy] = camera.toDevice(...this.refLine.from);
      const [tx, ty] = camera.toDevice(...this.refLine.to);
      const accent = getComputedStyle(this.el.shell)
        .getPropertyValue("--accent")
        .trim();
      ctx.strokeStyle = accent || "#8fa3ff";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 2 * camera.dpr;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tx, ty, 4 * camera.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The minimap element's rectangle in the canvas's device pixels.
  minimapRect() {
    const canvas = this.el.canvas.getBoundingClientRect();
    const minimap = this.el.minimap.getBoundingClientRect();
    const dpr = this.camera.dpr;
    return [
      (minimap.left - canvas.left) * dpr,
      (minimap.top - canvas.top) * dpr,
      (minimap.right - canvas.left) * dpr,
      (minimap.bottom - canvas.top) * dpr,
    ];
  }

  // The viewport outlined on the minimap. What it outlines is drawn by the
  // renderer underneath (frame()).
  drawMinimap() {
    const { minimap } = this.el;
    const ctx = minimap.getContext("2d");

    ctx.clearRect(0, 0, minimap.width, minimap.height);

    const scale = minimap.width / this.camera.worldSize;
    const r = this.camera.viewRect();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, this.camera.dpr);
    ctx.strokeRect(
      r.x0 * scale,
      r.y0 * scale,
      (r.x1 - r.x0) * scale,
      (r.y1 - r.y0) * scale,
    );
  }

  local(event) {
    const rect = this.el.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  point(x, y, pointerType) {
    const [wx, wy] = this.camera.toWorld(x, y);
    return { cssX: x, cssY: y, wx, wy, pointerType };
  }

  listen() {
    const { canvas, shell, minimap } = this.el;

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      const at = this.local(event);
      this.pointers.set(event.pointerId, at);
      if (this.pointers.size === 1) {
        this.gesture = {
          start: at,
          moved: false,
          pointerType: event.pointerType,
        };
      } else {
        this.gesture = { ...this.gesture, moved: true };
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      const at = this.local(event);
      const previous = this.pointers.get(event.pointerId);

      // A mouse with no button down is hovering.
      if (previous === undefined) {
        if (event.pointerType === "mouse") {
          this.scheduleHover(this.point(at.x, at.y, event.pointerType));
        }
        return;
      }

      // Two pointers: pinch around their midpoint and pan with it.
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const other = a === previous ? b : a;
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(at.x - other.x, at.y - other.y);
        const midBefore = {
          x: (previous.x + other.x) / 2,
          y: (previous.y + other.y) / 2,
        };
        const midAfter = { x: (at.x + other.x) / 2, y: (at.y + other.y) / 2 };
        this.pointers.set(event.pointerId, at);
        if (before > 0 && after > 0) {
          this.camera.zoomAround(
            midBefore.x,
            midBefore.y,
            Math.log2(after / before),
          );
        }
        this.camera.panBy(midAfter.x - midBefore.x, midAfter.y - midBefore.y);
        this.requestFrame();
        return;
      }

      // One pointer: drag to pan once it has moved past the threshold.
      this.pointers.set(event.pointerId, at);
      const start = this.gesture?.start ?? at;
      if (
        !this.gesture.moved &&
        Math.hypot(at.x - start.x, at.y - start.y) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      this.gesture.moved = true;
      this.camera.panBy(at.x - previous.x, at.y - previous.y);
      this.requestFrame();
      if (event.pointerType === "mouse") {
        this.scheduleHover(this.point(at.x, at.y, event.pointerType));
      }
    });

    const release = (event) => {
      if (!this.pointers.has(event.pointerId)) {
        return;
      }
      const at = this.local(event);
      this.pointers.delete(event.pointerId);
      const gesture = this.gesture;
      if (
        this.pointers.size > 0 ||
        gesture === null ||
        event.type === "pointercancel"
      ) {
        return;
      }
      this.gesture = null;
      if (gesture.moved) {
        return;
      }

      // A double tap zooms in; a single tap or click selects.
      const now = performance.now();
      const tap = this.lastTap;
      if (
        event.pointerType !== "mouse" &&
        tap !== null &&
        now - tap.time < DOUBLE_TAP_MS &&
        Math.hypot(at.x - tap.x, at.y - tap.y) < DRAG_THRESHOLD_PX * 3
      ) {
        this.lastTap = null;
        this.camera.zoomAround(at.x, at.y, DOUBLE_CLICK_ZOOM);
        this.requestFrame();
        return;
      }
      this.lastTap = { time: now, x: at.x, y: at.y };
      this.callbacks.onSelect?.(this.point(at.x, at.y, event.pointerType));
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    canvas.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse" && this.pointers.size === 0) {
        this.scheduleHover(null);
      }
    });

    canvas.addEventListener("dblclick", (event) => {
      const at = this.local(event);
      this.camera.zoomAround(
        at.x,
        at.y,
        event.shiftKey ? -DOUBLE_CLICK_ZOOM : DOUBLE_CLICK_ZOOM,
      );
      this.requestFrame();
    });

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const at = this.local(event);
        const unit =
          event.deltaMode === DOM_DELTA_LINE
            ? WHEEL_LINE_PX
            : event.deltaMode === DOM_DELTA_PAGE
              ? WHEEL_PAGE_PX
              : 1;
        const perPixel = event.ctrlKey
          ? PINCH_ZOOM_PER_PIXEL
          : WHEEL_ZOOM_PER_PIXEL;
        this.camera.zoomAround(at.x, at.y, -event.deltaY * unit * perPixel);
        this.requestFrame();
        this.scheduleHover(
          this.point(at.x, at.y, event.pointerType ?? "mouse"),
        );
      },
      { passive: false },
    );

    // Safari reports a trackpad pinch as gesture events carrying the
    // cumulative scale, rather than as ctrl-wheel events.
    let gestureScale = 1;
    canvas.addEventListener("gesturestart", (event) => {
      event.preventDefault();
      gestureScale = 1;
    });
    canvas.addEventListener("gesturechange", (event) => {
      event.preventDefault();
      const at = this.local(event);
      this.camera.zoomAround(at.x, at.y, Math.log2(event.scale / gestureScale));
      gestureScale = event.scale;
      this.requestFrame();
    });
    canvas.addEventListener("gestureend", (event) => event.preventDefault());

    shell.addEventListener("keydown", (event) => this.key(event));

    // The minimap moves the view. Pressing inside the viewport box grabs
    // the box and drags it; pressing anywhere else centres the view there
    // and keeps dragging from that point. Scrolling over it zooms.
    let grab = null;
    const worldAt = (event) => {
      const rect = minimap.getBoundingClientRect();
      const scale = this.camera.worldSize / rect.width;
      return [
        (event.clientX - rect.left) * scale,
        (event.clientY - rect.top) * scale,
      ];
    };
    minimap.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      try {
        minimap.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture; the drag still works
        // while the pointer stays over the minimap.
      }
      const [wx, wy] = worldAt(event);
      const view = this.camera.viewRect();
      const inside =
        wx >= view.x0 && wx <= view.x1 && wy >= view.y0 && wy <= view.y1;
      grab = inside ? [this.camera.cx - wx, this.camera.cy - wy] : [0, 0];
      this.camera.set(wx + grab[0], wy + grab[1], this.camera.zoom);
      this.requestFrame();
    });
    minimap.addEventListener("pointermove", (event) => {
      if (grab === null) {
        return;
      }
      const [wx, wy] = worldAt(event);
      this.camera.set(wx + grab[0], wy + grab[1], this.camera.zoom);
      this.requestFrame();
    });
    const releaseMinimap = () => {
      grab = null;
    };
    minimap.addEventListener("pointerup", releaseMinimap);
    minimap.addEventListener("pointercancel", releaseMinimap);
    minimap.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        const cssWidth = this.camera.width / this.camera.dpr;
        const cssHeight = this.camera.height / this.camera.dpr;
        this.camera.zoomAround(
          cssWidth / 2,
          cssHeight / 2,
          -event.deltaY * WHEEL_ZOOM_PER_PIXEL,
        );
        this.requestFrame();
      },
      { passive: false },
    );
  }

  key(event) {
    if (event.target instanceof HTMLInputElement || this.model === null) {
      return;
    }
    const camera = this.camera;
    const cssWidth = camera.width / camera.dpr;
    const cssHeight = camera.height / camera.dpr;
    const pan = {
      ArrowLeft: [-cssWidth * KEY_PAN_FRACTION, 0],
      ArrowRight: [cssWidth * KEY_PAN_FRACTION, 0],
      ArrowUp: [0, -cssHeight * KEY_PAN_FRACTION],
      ArrowDown: [0, cssHeight * KEY_PAN_FRACTION],
    }[event.key];

    if (pan !== undefined) {
      camera.panBy(-pan[0], -pan[1]);
    } else if (event.key === "+" || event.key === "=") {
      camera.zoomAround(cssWidth / 2, cssHeight / 2, KEY_ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      camera.zoomAround(cssWidth / 2, cssHeight / 2, -KEY_ZOOM_STEP);
    } else if (event.key === "0") {
      camera.fit(this.bounds);
    } else if (event.key === "f") {
      this.callbacks.onFlyToSelected?.();
    } else if (event.key === "Escape") {
      this.callbacks.onEscape?.();
    } else {
      return;
    }
    event.preventDefault();
    this.requestFrame();
  }

  scheduleHover(point) {
    this.hoverPoint = point;
    if (this.hoverScheduled) {
      return;
    }
    this.hoverScheduled = true;
    requestAnimationFrame(() => {
      this.hoverScheduled = false;
      this.callbacks.onHover?.(this.hoverPoint);
    });
  }

  // Whether the view is at the coarsest LOD, for the empty-world case.
  atTop() {
    return this.model !== null && maxLod(this.model.order) === 0;
  }
}
