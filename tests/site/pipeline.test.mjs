// Tests the NAR pipeline end to end on the real vendored decoders: the
// sample NAR compressed with xz, zstd and bzip2 (and uncompressed) is
// streamed in small pieces, decoded, hashed, indexed, summarised and
// scanned in one pass, and must come out as the bytes nix packed. A wrong
// NarHash, a wrong NarSize and a truncated stream must each fail with a
// message saying which.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { parseNar } from "../../site/js/nar.js";

const vendored = new URL("../../site/vendor/crabz2.js", import.meta.url);
const hasVendor = existsSync(vendored);
const skip = !hasVendor && "site/vendor is only assembled by the nix build";

const { processNar } = hasVendor
  ? await import("../../site/js/nar-pipeline.js")
  : { processNar: null };

// node's fetch cannot read the file: URL the wasm-bindgen glue asks for,
// so the decoder is initialised from the bytes instead. The pipeline's own
// initialisation then finds it already done.
if (hasVendor) {
  const crabz2 = await import(vendored.href);
  await crabz2.default({
    module_or_path: await readFile(
      new URL("../../site/vendor/crabz2_bg.wasm", import.meta.url),
    ),
  });
}

const NAR_HASH = "sha256:06izwy5alsqzl63vmbswc2yivlxcljshhw91hwb94hsdj13yny19";
const NAR_SIZE = 904;
const PIECE = 37;

const fixture = async (name) =>
  new Uint8Array(await readFile(new URL(`../fixtures/${name}`, import.meta.url)));

// A body that hands out the bytes a few at a time, the way a network
// response does.
function streamOf(bytes) {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + PIECE));
      at += PIECE;
    },
  });
}

async function run(file, compression, overrides = {}) {
  const chunks = [];
  const result = await processNar({
    body: streamOf(await fixture(file)),
    compression,
    narSize: NAR_SIZE,
    narHash: NAR_HASH,
    digests: new Map(),
    sink: (chunk) => chunks.push(chunk.slice()),
    ...overrides,
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return { result, joined };
}

for (const [file, compression] of [
  ["sample.nar", "none"],
  ["sample.nar.xz", "xz"],
  ["sample.nar.zst", "zstd"],
  ["sample.nar.bz2", "bzip2"],
]) {
  test(`${compression}: decodes, verifies and indexes in one pass`, { skip }, async () => {
    const nar = await fixture("sample.nar");
    const { result, joined } = await run(file, compression);

    assert.deepEqual(joined, nar);
    assert.equal(result.narBytes, NAR_SIZE);
    assert.equal(result.index.entries.length, parseNar(nar).length);
    assert.equal(result.summary.coarse.length, 4);
    assert.ok(result.compressedBytes > 0);
  });
}

test("a NarHash that does not match fails by name", { skip }, async () => {
  const wrong = "sha256:1".padEnd(59, "0");
  await assert.rejects(run("sample.nar.xz", "xz", { narHash: wrong }), /sha256 does not match/);
});

test("a NarSize that does not match fails by name", { skip }, async () => {
  await assert.rejects(run("sample.nar.zst", "zstd", { narSize: 900 }), /narinfo says 900/);
});

test("a truncated compressed stream fails", { skip }, async () => {
  const bytes = await fixture("sample.nar.xz");
  await assert.rejects(
    processNar({
      body: streamOf(bytes.subarray(0, bytes.length - 40)),
      compression: "xz",
      narSize: NAR_SIZE,
      narHash: NAR_HASH,
      digests: new Map(),
    }),
  );
});

test("an unknown compression is refused before any bytes are read", { skip }, async () => {
  await assert.rejects(
    run("sample.nar", "lz4"),
    /unsupported NAR compression "lz4"/,
  );
});
