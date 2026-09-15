// Tests the section table behind the "sections" colour mode. Section
// headers classify by name, type and flags; a NAR holding a minimal ELF64
// file (built in the test, with .text, .rodata, .data and .symtab) yields
// ranges shifted to NAR offsets; files that are not ELF, or not in a
// likely place, contribute nothing; and kindAt answers NONE between
// sections.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SectionKind,
  buildSectionTable,
  classifySection,
  kindAt,
  likelyElf,
} from "../../site/js/sections.js";

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;

test("sections classify by name, type and flags", () => {
  const kind = (name, type, flags) => classifySection({ name, type, flags });
  assert.equal(
    kind(".text", SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR),
    SectionKind.CODE,
  );
  assert.equal(kind(".rodata", SHT_PROGBITS, SHF_ALLOC), SectionKind.READ_ONLY);
  assert.equal(
    kind(".data", SHT_PROGBITS, SHF_ALLOC | SHF_WRITE),
    SectionKind.WRITABLE,
  );
  assert.equal(kind(".symtab", SHT_SYMTAB, 0), SectionKind.SYMBOLS);
  assert.equal(kind(".dynstr", SHT_STRTAB, SHF_ALLOC), SectionKind.SYMBOLS);
  assert.equal(kind(".rela.dyn", SHT_RELA, SHF_ALLOC), SectionKind.RELOCATIONS);
  assert.equal(kind(".debug_info", SHT_PROGBITS, 0), SectionKind.DEBUG);
  assert.equal(kind(".comment", SHT_PROGBITS, 0), SectionKind.METADATA);
});

test("only executables and files where binaries live are checked", () => {
  const regular = (path, extra = {}) => ({
    type: "regular",
    path,
    size: 1000,
    executable: false,
    ...extra,
  });
  assert.equal(likelyElf(regular("lib/libc.so.6")), true);
  assert.equal(likelyElf(regular("bin/hello")), true);
  assert.equal(likelyElf(regular("share/tool", { executable: true })), true);
  assert.equal(likelyElf(regular("share/doc/README")), false);
  assert.equal(likelyElf(regular("lib/python3.14/os.py")), true);
  assert.equal(likelyElf(regular("lib/libc.so.6", { size: 10 })), false);
});

// .text at 0x100 (0x40), .rodata at 0x140 (0x20), .data at 0x160 (0x10),
// .bss (no bytes), .symtab at 0x170 (0x18), names at 0x188.
function buildElf() {
  const names = "\0.text\0.rodata\0.data\0.bss\0.symtab\0.shstrtab\0";
  const bytes = new Uint8Array(0x200 + 7 * 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  view.setBigUint64(0x28, 0x200n, true);
  view.setUint16(0x3a, 64, true);
  view.setUint16(0x3c, 7, true);
  view.setUint16(0x3e, 6, true);
  bytes.set(new TextEncoder().encode(names), 0x188);
  const section = (i, nameOffset, type, flags, offset, size) => {
    const at = 0x200 + i * 64;
    view.setUint32(at, nameOffset, true);
    view.setUint32(at + 4, type, true);
    view.setBigUint64(at + 8, BigInt(flags), true);
    view.setBigUint64(at + 0x18, BigInt(offset), true);
    view.setBigUint64(at + 0x20, BigInt(size), true);
  };
  section(1, 1, SHT_PROGBITS, SHF_ALLOC | SHF_EXECINSTR, 0x100, 0x40);
  section(2, 7, SHT_PROGBITS, SHF_ALLOC, 0x140, 0x20);
  section(3, 15, SHT_PROGBITS, SHF_ALLOC | SHF_WRITE, 0x160, 0x10);
  section(4, 21, SHT_NOBITS, SHF_ALLOC | SHF_WRITE, 0x170, 0x100);
  section(5, 26, SHT_SYMTAB, 0, 0x170, 0x18);
  section(6, 34, SHT_STRTAB, 0, 0x188, names.length);
  return bytes;
}

test("an ELF inside a NAR becomes ranges at NAR offsets", async () => {
  const elf = buildElf();
  const text = new TextEncoder().encode("not an elf, just text\n".repeat(10));
  const ELF_AT = 1000;
  const TEXT_AT = 5000;
  const nar = new Uint8Array(8000);
  nar.set(elf, ELF_AT);
  nar.set(text, TEXT_AT);
  const entries = [
    { path: "", type: "directory" },
    {
      path: "lib/libdemo.so",
      type: "regular",
      executable: false,
      contentOffset: ELF_AT,
      size: elf.length,
    },
    {
      path: "lib/notes.so",
      type: "regular",
      executable: false,
      contentOffset: TEXT_AT,
      size: text.length,
    },
  ];
  const readNar = async (offset, length) => nar.slice(offset, offset + length);

  const table = await buildSectionTable(entries, readNar);
  assert.deepEqual(
    [...table.kinds],
    [
      SectionKind.CODE,
      SectionKind.READ_ONLY,
      SectionKind.WRITABLE,
      SectionKind.SYMBOLS,
      SectionKind.SYMBOLS,
    ],
  );
  assert.equal(kindAt(table, ELF_AT + 0x100), SectionKind.CODE);
  assert.equal(kindAt(table, ELF_AT + 0x13f), SectionKind.CODE);
  assert.equal(kindAt(table, ELF_AT + 0x140), SectionKind.READ_ONLY);
  assert.equal(kindAt(table, ELF_AT + 0x10), SectionKind.NONE);
  assert.equal(kindAt(table, TEXT_AT + 5), SectionKind.NONE);
});
