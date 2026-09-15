// Tests the join behind the package lane's version list: every version in
// either shard gets a row, newest first, a version with a meta entry
// carries its store path and closure size, and one without is unbuilt.
// Also the version ordering the newest pick relies on.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bootable,
  compareVersions,
  mergeVersions,
} from "../../site/js/multiverse.js";

const DIGEST = "xl1h9i29pgq2q5cszjhm5wpfxfbbqwyi";

test("every version gets a row, built ones with their store path", () => {
  const rows = mergeVersions(
    "hello",
    { "2.10": 0, "2.12.3": 1, 2.9: 2 },
    {
      "2.12.3": { d: DIGEST, cs: 1234 },
      "2.10": { d: DIGEST, n: "hello-2.10-x" },
    },
  );
  assert.deepEqual(
    rows.map((r) => [r.version, bootable(r)]),
    [
      ["2.12.3", true],
      ["2.10", true],
      ["2.9", false],
    ],
  );
  assert.equal(rows[0].storePath, `/nix/store/${DIGEST}-hello-2.12.3`);
  assert.equal(rows[0].closureSize, 1234);
  assert.equal(rows[1].name, "hello-2.10-x");
  assert.equal(rows[2].storePath, null);
});

test("versions order numerically, a release above its prerelease", () => {
  assert.ok(compareVersions("2.10", "2.9") > 0);
  assert.ok(compareVersions("1.2", "1.2-rc1") > 0);
  assert.equal(compareVersions("3.14.7", "3.14.7"), 0);
});
