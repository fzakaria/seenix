// Tests the path-info importer on real `nix path-info -r --json` output of
// ncurses's closure in each shape Nix has written: format 1 keyed by full
// store path with SRI hashes, format 2 keyed by basename, and the older
// array with sha256:<nix32> hashes. All three must yield the same records,
// the same root, and hashes spelled the way a narinfo spells them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parsePathInfo } from "../../site/js/import.js";

const fixture = (name) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const NCURSES = "ffyzkisqs4vc4mg28bwwlyqjf8i9ph6b";
const GLIBC = "7nbi22pcc92y2fqbkyp7h3srvvklmckb";
const GLIBC_HASH = "sha256:0616hw8gp2ac9l6z27p966lbxpd90m8wsxb8vq29rz1cbr1vvisg";

// The fields every shape must agree on, sorted by digest.
const summary = ({ records }) =>
  records
    .map((r) => ({
      digest: r.digest,
      name: r.name,
      narSize: r.narSize,
      narHash: r.narHash,
      references: [...r.references].sort(),
      deriver: r.deriver,
      sigs: r.sigs,
    }))
    .sort((a, b) => (a.digest < b.digest ? -1 : 1));

for (const name of [
  "path-info-v1.json",
  "path-info-v2.json",
  "path-info-array.json",
]) {
  test(`${name}: every path, its root, and narinfo-spelled hashes`, async () => {
    const result = parsePathInfo(await fixture(name));
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.length, 5);
    assert.deepEqual(result.roots, [NCURSES]);

    const glibc = result.records.find((r) => r.digest === GLIBC);
    assert.equal(glibc.name, "glibc-2.40-224");
    assert.equal(glibc.storePath, `/nix/store/${GLIBC}-glibc-2.40-224`);
    assert.equal(glibc.narHash, GLIBC_HASH);
    assert.equal(glibc.narSize, 30180096);
    assert.ok(glibc.references.includes(GLIBC));
    assert.equal(glibc.deriver, "fynmmhgd2qyxbxxs0cii34zj37mv3xcm-glibc-2.40-224.drv");
  });
}

test("the three shapes describe the same closure", async () => {
  const v1 = summary(parsePathInfo(await fixture("path-info-v1.json")));
  const v2 = summary(parsePathInfo(await fixture("path-info-v2.json")));
  const array = summary(parsePathInfo(await fixture("path-info-array.json")));
  assert.deepEqual(v2, v1);
  assert.deepEqual(array, v1);
});

test("a path without narSize is reported, the rest still import", () => {
  const good = `/nix/store/${GLIBC}-glibc`;
  const bad = `/nix/store/${NCURSES}-ncurses`;
  const result = parsePathInfo({
    [good]: { narSize: 1, references: [] },
    [bad]: { references: [good] },
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /narSize/);
});
