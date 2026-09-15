// Tests the reference scanner the way Nix finds runtime references: any
// 32 bytes of the base32 alphabet that spell a digest in the closure. A
// digest must be found at its exact offset however the stream is split,
// including inside a longer alphabet run, and a digest outside the
// closure must be ignored.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RefScanner } from "../../site/js/refscan.js";

const GLIBC = "7nbi22pcc92y2fqbkyp7h3srvvklmckb";
const NCURSES = "ffyzkisqs4vc4mg28bwwlyqjf8i9ph6b";
const STRANGER = "xl1h9i29pgq2q5cszjhm5wpfxfbbqwyi";

const PREFIX = "\x7fELF...RPATH=/nix/store/";
const text = `${PREFIX}${GLIBC}-glibc/lib:/nix/store/${STRANGER}-x \x00 ab${NCURSES}`;
const bytes = new TextEncoder().encode(text);

const closure = new Map([
  [GLIBC, 3],
  [NCURSES, 7],
]);

test("digests are found at their offsets across every split", () => {
  const want = [
    { offset: text.indexOf(GLIBC), target: 3 },
    { offset: text.indexOf(NCURSES), target: 7 },
  ];
  for (let split = 1; split <= bytes.length; split += 1) {
    const scanner = new RefScanner(closure);
    for (let at = 0; at < bytes.length; at += split) {
      scanner.push(bytes.subarray(at, at + split));
    }
    const { hits, truncated } = scanner.finish();
    assert.equal(truncated, false);
    assert.deepEqual(hits, want, `split ${split}`);
  }
});

test("the hit cap truncates", () => {
  const scanner = new RefScanner(closure, { cap: 1 });
  scanner.push(bytes);
  const { hits, truncated } = scanner.finish();
  assert.equal(hits.length, 1);
  assert.equal(truncated, true);
});
