// Tests the layout: roots first and the rest by name then digest, starts
// that follow one another with no gap, the world order as ceil(log4) with
// a one-tile floor, references resolved to ids with the self-reference
// kept as a flag, and pathAt finding the owner of any byte and nothing in
// the padding.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLayout,
  orderFor,
  pathAt,
  pathRecord,
} from "../../site/js/layout.js";

const digest = (c) => c.repeat(32);

const record = (c, name, narSize, references = []) =>
  pathRecord({
    digest: digest(c),
    name,
    storePath: `/nix/store/${digest(c)}-${name}`,
    narSize,
    references: references.map(digest),
  });

test("roots lead, then paths sort by name and digest", () => {
  const layout = buildLayout(
    [
      record("b", "zlib", 10),
      record("a", "zlib", 10),
      record("c", "app", 5, ["a", "c"]),
      record("d", "bash", 7),
    ],
    [digest("c")],
  );
  assert.deepEqual(
    layout.paths.map((p) => [p.name, p.digest[0]]),
    [
      ["app", "c"],
      ["bash", "d"],
      ["zlib", "a"],
      ["zlib", "b"],
    ],
  );
  assert.deepEqual([...layout.offsets], [0, 5, 12, 22, 32]);
  assert.equal(layout.total, 32);
  assert.deepEqual(layout.roots, [0]);

  const app = layout.paths[0];
  assert.deepEqual(app.references, [2]);
  assert.equal(app.selfRef, true);
});

test("the world is the smallest power of four that fits, one tile at least", () => {
  assert.equal(orderFor(0), 8);
  assert.equal(orderFor(4 ** 8), 8);
  assert.equal(orderFor(4 ** 8 + 1), 9);
  assert.equal(orderFor(5 * 1024 ** 3), 17);
});

test("pathAt names the owner of every byte and -1 in the padding", () => {
  const offsets = Float64Array.from([0, 5, 5, 12]);
  assert.equal(pathAt(offsets, 0), 0);
  assert.equal(pathAt(offsets, 4), 0);
  // The zero-byte path at index 1 owns nothing; byte 5 is path 2's.
  assert.equal(pathAt(offsets, 5), 2);
  assert.equal(pathAt(offsets, 11), 2);
  assert.equal(pathAt(offsets, 12), -1);
  assert.equal(pathAt(offsets, -1), -1);
});

test("a reference outside the set is dropped", () => {
  const layout = buildLayout([record("a", "x", 1, ["z"])], [digest("a")]);
  assert.deepEqual(layout.paths[0].references, []);
});
