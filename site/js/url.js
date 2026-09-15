// The URL is the state. What is on the map lives in the query string, so
// any view is a link someone can send:
//
//   ?path=/nix/store/<digest>-name       a root; repeatable
//   &pkg=attr@version                    a root from the multiverse index
//   &json=https://.../closure.json       nix path-info -r --json, by URL
//   &cache=https://x.cachix.org x-1:key= an extra binary cache; repeatable
//   &mode=bytes|classes|entropy|package  the colour mode
//   &sel=<digest>                        the path pinned in the legend
//   &view=<cx>,<cy>,<zoom>               world centre and log2 zoom
//
// app.js writes it back with replaceState, throttled, so the address bar
// is always a shareable link to the current view.

import { DIGEST_PATTERN } from "./config.js";

const PARAM_PATH = "path";
const PARAM_PKG = "pkg";
const PARAM_JSON = "json";
const PARAM_CACHE = "cache";
const PARAM_MODE = "mode";
const PARAM_SEL = "sel";
const PARAM_VIEW = "view";
const VERSION_SEPARATOR = "@";
const VIEW_SEPARATOR = ",";
const VIEW_FIELDS = 3;

// The colour modes, in the order the switcher shows them. The value is
// what the shader's `mode` uniform receives.
export const Mode = Object.freeze({
  BYTES: "bytes",
  CLASSES: "classes",
  ENTROPY: "entropy",
  PACKAGE: "package",
});
export const MODES = Object.values(Mode);

// { paths, pkgs: [{attr, version|null}], json, caches: [{url, key}],
//   mode, sel, view: {cx, cy, zoom} | null }
export function readUrl(search = location.search) {
  const params = new URLSearchParams(search);

  const paths = params
    .getAll(PARAM_PATH)
    .flatMap((p) => p.split(",").filter(Boolean));

  const pkgs = params
    .getAll(PARAM_PKG)
    .flatMap((spec) => spec.split(",").filter(Boolean))
    .map((one) => {
      const at = one.lastIndexOf(VERSION_SEPARATOR);
      if (at <= 0) {
        return { attr: one, version: null };
      }
      return { attr: one.slice(0, at), version: one.slice(at + 1) };
    });

  // "url key", whitespace between; a value without a key is dropped
  // rather than trusted.
  const caches = params
    .getAll(PARAM_CACHE)
    .map((value) => value.trim().split(/\s+/))
    .filter((parts) => parts.length === 2)
    .map(([url, key]) => ({ url: url.replace(/\/$/, ""), key }));

  const mode = MODES.includes(params.get(PARAM_MODE))
    ? params.get(PARAM_MODE)
    : null;

  const sel = DIGEST_PATTERN.test(params.get(PARAM_SEL) ?? "")
    ? params.get(PARAM_SEL)
    : null;

  return {
    paths,
    pkgs,
    json: params.get(PARAM_JSON),
    caches,
    mode,
    sel,
    view: parseView(params.get(PARAM_VIEW)),
  };
}

function parseView(value) {
  if (value === null) {
    return null;
  }
  const parts = value.split(VIEW_SEPARATOR).map(Number);
  if (parts.length !== VIEW_FIELDS || !parts.every(Number.isFinite)) {
    return null;
  }
  const [cx, cy, zoom] = parts;
  return { cx, cy, zoom };
}

// World coordinates are kept to a tenth of a pixel and zoom to a
// hundredth of a doubling: enough to restore a view exactly as seen.
const VIEW_DIGITS = 1;
const ZOOM_DIGITS = 2;

// The query string for a state, as a path relative to this page.
export function writeUrl(state, pathname = location.pathname) {
  const params = new URLSearchParams();
  for (const path of state.paths ?? []) {
    params.append(PARAM_PATH, path);
  }
  for (const { attr, version } of state.pkgs ?? []) {
    params.append(
      PARAM_PKG,
      version === null ? attr : `${attr}${VERSION_SEPARATOR}${version}`,
    );
  }
  if (state.json) {
    params.set(PARAM_JSON, state.json);
  }
  for (const { url, key } of state.caches ?? []) {
    params.append(PARAM_CACHE, `${url} ${key}`);
  }
  if (state.mode) {
    params.set(PARAM_MODE, state.mode);
  }
  if (state.sel) {
    params.set(PARAM_SEL, state.sel);
  }
  if (state.view) {
    const { cx, cy, zoom } = state.view;
    params.set(
      PARAM_VIEW,
      [
        cx.toFixed(VIEW_DIGITS),
        cy.toFixed(VIEW_DIGITS),
        zoom.toFixed(ZOOM_DIGITS),
      ].join(VIEW_SEPARATOR),
    );
  }

  const query = params.toString();
  return `${pathname}${query === "" ? "" : `?${query}`}`;
}
