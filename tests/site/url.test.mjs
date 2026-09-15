// Tests the query-string grammar by writing a full state and reading it
// back: repeatable roots and caches keep their order, the view survives
// at the precision it is written with, and malformed values (an unknown
// mode, a non-digest selection, a short view) are dropped rather than
// trusted.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Mode, readUrl, writeUrl } from "../../site/js/url.js";

const DIGEST = "xl1h9i29pgq2q5cszjhm5wpfxfbbqwyi";

test("a written state reads back the same", () => {
  const state = {
    paths: [`/nix/store/${DIGEST}-hello-2.12.3`, "/nix/store/other"],
    pkgs: [
      { attr: "ripgrep", version: null },
      { attr: "python3", version: "3.12.1" },
    ],
    json: "https://example.com/closure.json",
    caches: [{ url: "https://x.cachix.org", key: "x.cachix.org-1:abc=" }],
    mode: Mode.ENTROPY,
    sel: DIGEST,
    view: { cx: 1234.5, cy: 99.25, zoom: -3.125 },
  };
  const link = writeUrl(state, "/");
  const back = readUrl(link.slice(1));
  assert.deepEqual(back.paths, state.paths);
  assert.deepEqual(back.pkgs, state.pkgs);
  assert.equal(back.json, state.json);
  assert.deepEqual(back.caches, state.caches);
  assert.equal(back.mode, Mode.ENTROPY);
  assert.equal(back.sel, DIGEST);
  assert.deepEqual(back.view, { cx: 1234.5, cy: 99.3, zoom: -3.13 });
});

test("malformed values are dropped", () => {
  const back = readUrl("?mode=rainbow&sel=nope&view=1,2&cache=https://nokey");
  assert.equal(back.mode, null);
  assert.equal(back.sel, null);
  assert.equal(back.view, null);
  assert.deepEqual(back.caches, []);
});
