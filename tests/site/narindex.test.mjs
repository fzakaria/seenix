// Tests the streaming NAR indexer against the whole-buffer parser on a
// NAR that `nix nar pack` wrote. The archive is fed split at every
// possible chunk boundary, and each split must produce parseNar's entries
// with contentOffset equal to the offset of the file's bytes in the
// buffer. Malformed and truncated input must fail with a named error, and
// fileAt must map a byte offset back to the file holding it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseNar } from "../../site/js/nar.js";
import { NarIndexer, buildFileLookup, fileAt } from "../../site/js/narindex.js";

const fixture = new URL("../fixtures/sample.nar", import.meta.url);

// A fresh copy, so the buffer starts at byteOffset 0 and a view's
// byteOffset is its offset in the archive.
const load = async () => new Uint8Array(await readFile(fixture));

// parseNar's entries in the indexer's shape.
function expected(bytes) {
  return parseNar(bytes).map((entry) => ({
    path: entry.path,
    type: entry.type,
    executable: entry.executable ?? false,
    contentOffset: entry.type === "regular" ? entry.data.byteOffset : -1,
    size: entry.type === "regular" ? entry.data.byteLength : 0,
    target: entry.target ?? null,
  }));
}

test("every split of the archive indexes the same as parseNar", async () => {
  const bytes = await load();
  const want = expected(bytes);

  for (let split = 1; split <= bytes.length; split += 1) {
    const indexer = new NarIndexer();
    for (let at = 0; at < bytes.length; at += split) {
      indexer.push(bytes.subarray(at, at + split));
    }
    const { entries, truncated } = indexer.finish();
    assert.equal(truncated, false);
    assert.deepEqual(entries, want, `split ${split}`);
  }
});

test("a truncated archive and a corrupt one fail by name", async () => {
  const bytes = await load();

  const short = new NarIndexer();
  short.push(bytes.subarray(0, bytes.length - 16));
  assert.throws(() => short.finish(), /bad NAR: archive ends early/);

  const corrupt = new Uint8Array(bytes);
  corrupt[8] = "X".charCodeAt(0);
  assert.throws(() => new NarIndexer().push(corrupt), /bad NAR/);
});

test("the entry cap truncates rather than failing", async () => {
  const bytes = await load();
  const indexer = new NarIndexer({ cap: 2 });
  indexer.push(bytes);
  const { entries, truncated } = indexer.finish();
  assert.equal(entries.length, 2);
  assert.equal(truncated, true);
});

test("fileAt finds the regular file holding an offset, -1 in framing", async () => {
  const bytes = await load();
  const indexer = new NarIndexer();
  indexer.push(bytes);
  const { entries } = indexer.finish();
  const lookup = buildFileLookup(entries);

  const file = entries.findIndex((e) => e.path === "file.txt");
  const { contentOffset, size } = entries[file];
  assert.equal(fileAt(lookup, contentOffset), file);
  assert.equal(fileAt(lookup, contentOffset + size - 1), file);
  assert.equal(fileAt(lookup, contentOffset - 1), -1);
  assert.equal(fileAt(lookup, 0), -1);
});
