// Colours that do not depend on the theme: a hue per package, and the
// byte palette the "bytes" mode looks up.

// FNV-1a, 32-bit.
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// The package part of a store name: everything before the first dash
// followed by a digit, so glibc-2.40-66 and glibc-2.40-66-bin share a hue.
export function packageName(name) {
  const match = /^(.+?)-\d/.exec(name);
  return match === null ? name : match[1];
}

export function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

const HUES = 360;
const SATURATION = 0.58;
const LIGHTNESS_BASE = 0.44;
const LIGHTNESS_STEPS = 14;

// A package's hue, with the lightness nudged per digest so two outputs of
// one package placed side by side can still be told apart.
export function packageColor(name, digest) {
  const hue = (hashString(packageName(name)) % HUES) / HUES;
  const light = LIGHTNESS_BASE + (hashString(digest) % LIGHTNESS_STEPS) / 100;
  return hslToRgb(hue, SATURATION, light);
}

const ramp = (from, to, t) =>
  from.map((c, i) => Math.round(c + (to[i] - c) * Math.min(1, Math.max(0, t))));

const TAB = 0x09;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const PRINTABLE_FIRST = 0x20;
const PRINTABLE_LAST = 0x7e;
const HIGH_FIRST = 0x80;
const LAST = 0xff;

// 256 RGBA entries: 0x00 black, low control bytes green, printable ASCII
// blue, high bytes red to amber, 0xff white.
export function bytePalette() {
  const palette = new Uint8Array(256 * 4);
  for (let b = 0; b < 256; b += 1) {
    let rgb;
    if (b === 0) {
      rgb = [0, 0, 0];
    } else if (b === LAST) {
      rgb = [255, 255, 255];
    } else if (b >= HIGH_FIRST) {
      rgb = ramp([150, 28, 28], [255, 196, 70], (b - HIGH_FIRST) / 0x7e);
    } else if (
      (b >= PRINTABLE_FIRST && b <= PRINTABLE_LAST) ||
      b === TAB ||
      b === NEWLINE ||
      b === RETURN
    ) {
      rgb = ramp([34, 74, 196], [130, 196, 255], (b - PRINTABLE_FIRST) / 0x5e);
    } else {
      rgb = ramp([22, 112, 52], [96, 220, 116], b / 0x7f);
    }
    palette.set([...rgb, 255], b * 4);
  }
  return palette;
}

// "#rrggbb" to [r, g, b] in 0..1, for the clear colour.
export function parseHexColor(text, fallback = [0, 0, 0]) {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (match === null) {
    return fallback;
  }
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}
