// Tests ELF64 section lookup on a minimal little-endian ELF built in the
// test: a header, a .text and a .rodata section, and the section-name
// string table. Reads go through an async slice function, the way the page
// reads a file out of a NAR on disk. Anything but ELF64 little-endian must
// be reported as unsupported rather than misread.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readElfSections, sectionAt } from "../../site/js/elf.js";

const HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 64;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;

// .text at 0x100 (0x40 bytes), .rodata at 0x140 (0x20 bytes), the string
// table at 0x160, section headers at 0x200.
function buildElf() {
  const names = "\0.text\0.rodata\0.shstrtab\0";
  const bytes = new Uint8Array(0x200 + 4 * SECTION_HEADER_SIZE);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  view.setBigUint64(0x28, 0x200n, true); // e_shoff
  view.setUint16(0x3a, SECTION_HEADER_SIZE, true); // e_shentsize
  view.setUint16(0x3c, 4, true); // e_shnum
  view.setUint16(0x3e, 3, true); // e_shstrndx
  bytes.set(new TextEncoder().encode(names), 0x160);

  const section = (i, nameOffset, type, offset, size) => {
    const at = 0x200 + i * SECTION_HEADER_SIZE;
    view.setUint32(at, nameOffset, true);
    view.setUint32(at + 4, type, true);
    view.setBigUint64(at + 0x18, BigInt(offset), true);
    view.setBigUint64(at + 0x20, BigInt(size), true);
  };
  section(1, 1, SHT_PROGBITS, 0x100, 0x40);
  section(2, 7, SHT_PROGBITS, 0x140, 0x20);
  section(3, 15, SHT_STRTAB, 0x160, names.length);
  return bytes;
}

const reader = (bytes) => async (offset, length) =>
  bytes.slice(offset, offset + length);

test("sections come back named, and an offset maps to its section", async () => {
  const result = await readElfSections(reader(buildElf()));
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.sections.map((s) => s.name),
    ["", ".text", ".rodata", ".shstrtab"],
  );
  assert.equal(sectionAt(result.sections, 0x100).name, ".text");
  assert.equal(sectionAt(result.sections, 0x13f).name, ".text");
  assert.equal(sectionAt(result.sections, 0x140).name, ".rodata");
  assert.equal(sectionAt(result.sections, 0x10), null);
});

test("a 32-bit or big-endian ELF is unsupported, not misread", async () => {
  const elf32 = buildElf();
  elf32[4] = 1;
  const big = buildElf();
  big[5] = 2;
  for (const bytes of [elf32, big]) {
    const result = await readElfSections(reader(bytes));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unsupported/);
  }
  assert.equal(HEADER_SIZE, 64);
});
