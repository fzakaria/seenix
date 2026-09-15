// Tests the narinfo parser in site/js/closure.js against a fixture that
// mirrors what cache.nixos.org serves: every field the walk reads comes
// back typed, references split into basenames, and the digest helper
// takes the leading 32 characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseNarinfo, digestOf } from "../../site/js/closure.js";

const fixture = new URL("../fixtures/hello.narinfo", import.meta.url);

test("parseNarinfo reads the fields the walk needs", async () => {
  const info = parseNarinfo(await readFile(fixture, "utf8"));

  assert.equal(
    info.storePath,
    "/nix/store/18bbdvag5v2f3d4y37pdbkzvh7s71cw4-hello-2.12.2",
  );
  assert.equal(
    info.url,
    "nar/0fixture0fixture0fixture0fixture0fixture0fixture0000.nar.xz",
  );
  assert.equal(info.compression, "xz");
  assert.equal(info.fileSize, 50560);
  assert.equal(info.narSize, 226504);
  assert.deepEqual(info.references, [
    "18bbdvag5v2f3d4y37pdbkzvh7s71cw4-hello-2.12.2",
    "wx1vk75bpdr65g6xwxbj4rw0pk04v5j3-glibc-2.27",
  ]);
});

test("parseNarinfo treats a missing References line as no references", () => {
  const info = parseNarinfo("StorePath: /nix/store/x\nNarSize: 7\n");
  assert.deepEqual(info.references, []);
  assert.equal(info.narSize, 7);
  assert.equal(info.fileSize, 0);
});

test("parseNarinfo collects every signature, not the last one", () => {
  const info = parseNarinfo(
    [
      "StorePath: /nix/store/x",
      "Sig: cache.nixos.org-1:aaa",
      "Sig: other-1:bbb",
      "",
    ].join("\n"),
  );
  assert.deepEqual(info.sigs, ["cache.nixos.org-1:aaa", "other-1:bbb"]);
});

test("digestOf takes the digest half of a store basename", () => {
  assert.equal(
    digestOf("wx1vk75bpdr65g6xwxbj4rw0pk04v5j3-glibc-2.27"),
    "wx1vk75bpdr65g6xwxbj4rw0pk04v5j3",
  );
});

// Tests the fields kept for the legend: Deriver and
// CA come back as written, and null when the narinfo has none.
test("parseNarinfo keeps Deriver, and CA when present", async () => {
  const info = parseNarinfo(await readFile(fixture, "utf8"));
  assert.equal(info.deriver, "2fixture2fixture2fixture2fixture-hello-2.12.2.drv");
  assert.equal(info.ca, null);
  assert.equal(parseNarinfo("CA: fixed:r:sha256:abc\n").ca, "fixed:r:sha256:abc");
});

// Tests the closure walk against an in-memory cache: a diamond is fetched
// once per path, and a reference no cache holds is reported as missing
// without abandoning the rest of the walk.
import { walkClosure } from "../../site/js/closure.js";

test("walkClosure visits a diamond once and reports what is missing", async () => {
  const d = (c) => c.repeat(32);
  const graph = {
    [d("a")]: [d("b"), d("c")],
    [d("b")]: [d("d")],
    [d("c")]: [d("d"), d("z")],
    [d("d")]: [],
  };
  const fetched = [];
  const fetchInfo = async (digest) => {
    fetched.push(digest);
    if (!(digest in graph)) {
      throw new Error("not found");
    }
    return { references: graph[digest].map((x) => `${x}-name`) };
  };

  const { closure, missing } = await walkClosure([d("a")], fetchInfo);
  assert.deepEqual([...closure.keys()].sort(), [d("a"), d("b"), d("c"), d("d")]);
  assert.deepEqual([...missing.keys()], [d("z")]);
  assert.equal(fetched.length, 5);
});
