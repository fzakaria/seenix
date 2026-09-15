// Tests the share formatting the statistics panel uses: a 17 KiB path in
// a 36 MiB closure must not read as 0%, the rest must not read as 100%,
// and ordinary shares keep whole numbers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { percent } from "../../site/js/format.js";

test("tiny and near-total shares say so rather than rounding away", () => {
  const closure = 36 * 1024 * 1024;
  const example = 17 * 1024;
  assert.equal(percent(example, closure), "<0.1%");
  assert.equal(percent(closure - example, closure), ">99.9%");
});

test("ordinary shares round as expected", () => {
  assert.equal(percent(0, 10), "0%");
  assert.equal(percent(10, 10), "100%");
  assert.equal(percent(37, 100), "37%");
  assert.equal(percent(5, 100), "5.0%");
  assert.equal(percent(995, 1000), "99.5%");
});
