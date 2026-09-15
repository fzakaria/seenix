// What each byte of an ELF file is for, as a sorted table of NAR byte
// ranges and section kinds. The "sections" colour mode draws it.
//
// A NAR's file index says where each file's bytes start. For the files
// that look like ELF, the section header table is read from the NAR on
// disk (elf.js), each section with file bytes is classified, and its
// range is shifted by the file's contentOffset into NAR coordinates.

import { isElf, readElfSections } from "./elf.js";
import { EntryType } from "./narindex.js";

// The kinds, as the small integers a tile's ids texture carries. 0 is a
// byte in no known section: NAR framing, a file that is not ELF, or an
// ELF header and the gaps between sections.
export const SectionKind = Object.freeze({
  NONE: 0,
  CODE: 1,
  READ_ONLY: 2,
  WRITABLE: 3,
  SYMBOLS: 4,
  RELOCATIONS: 5,
  DEBUG: 6,
  METADATA: 7,
});

const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNSYM = 11;
const SHT_REL = 9;
const SHT_NOBITS = 8;
const SHT_RELR = 19;
const SHT_GNU_VERSYM = 0x6fffffff;
const SHT_GNU_VERDEF = 0x6ffffffd;
const SHT_GNU_VERNEED = 0x6ffffffe;
const SHT_GNU_HASH = 0x6ffffff6;
const SHT_HASH = 5;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

const SYMBOL_TYPES = new Set([
  SHT_SYMTAB,
  SHT_STRTAB,
  SHT_DYNSYM,
  SHT_HASH,
  SHT_GNU_HASH,
  SHT_GNU_VERSYM,
  SHT_GNU_VERDEF,
  SHT_GNU_VERNEED,
]);
const RELOCATION_TYPES = new Set([SHT_REL, SHT_RELA, SHT_RELR]);
const DEBUG_PREFIXES = [".debug", ".zdebug", ".gnu_debug"];

// One section header's kind.
export function classifySection(section) {
  if (DEBUG_PREFIXES.some((prefix) => section.name.startsWith(prefix))) {
    return SectionKind.DEBUG;
  }
  if (SYMBOL_TYPES.has(section.type)) {
    return SectionKind.SYMBOLS;
  }
  if (RELOCATION_TYPES.has(section.type)) {
    return SectionKind.RELOCATIONS;
  }
  if (section.flags & SHF_EXECINSTR) {
    return SectionKind.CODE;
  }
  if (section.flags & SHF_ALLOC) {
    return section.flags & SHF_WRITE
      ? SectionKind.WRITABLE
      : SectionKind.READ_ONLY;
  }
  return SectionKind.METADATA;
}

// Files worth checking for the ELF magic. Reading four bytes of every file
// in a Python closure would cost thousands of reads for .py files, so
// only executables, shared objects and the directories binaries live in
// are asked.
const ELF_SIZE_MIN = 64;
const LIKELY_ELF =
  /(^|\/)(bin|sbin|lib|lib64|libexec)\/|\.so(\.\d+)*$|\.o$|\.a$/;

export function likelyElf(entry) {
  return (
    entry.type === EntryType.REGULAR &&
    entry.size >= ELF_SIZE_MIN &&
    (entry.executable || LIKELY_ELF.test(entry.path))
  );
}

// { starts, ends, kinds }: section ranges in NAR offsets, sorted by start.
// `readNar(offset, length)` reads the NAR. Files whose headers cannot be
// read or are not ELF64 little-endian contribute nothing.
export async function buildSectionTable(
  entries,
  readNar,
  { concurrency = 16 } = {},
) {
  const candidates = entries.filter(likelyElf);
  const ranges = [];
  let next = 0;

  async function worker() {
    for (;;) {
      const entry = candidates[next];
      next += 1;
      if (entry === undefined) {
        return;
      }
      const readFile = (offset, length) =>
        readNar(
          entry.contentOffset + offset,
          Math.max(0, Math.min(length, entry.size - offset)),
        );
      try {
        if (!isElf(await readFile(0, 4))) {
          continue;
        }
        const elf = await readElfSections(readFile);
        if (!elf.ok) {
          continue;
        }
        for (const section of elf.sections) {
          const inFile =
            section.size > 0 &&
            section.type !== SHT_NOBITS &&
            section.offset + section.size <= entry.size;
          if (!inFile) {
            continue;
          }
          ranges.push([
            entry.contentOffset + section.offset,
            entry.contentOffset + section.offset + section.size,
            classifySection(section),
          ]);
        }
      } catch {
        // An unreadable file draws as no section.
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  ranges.sort((a, b) => a[0] - b[0]);
  return {
    starts: Float64Array.from(ranges, (r) => r[0]),
    ends: Float64Array.from(ranges, (r) => r[1]),
    kinds: Uint8Array.from(ranges, (r) => r[2]),
  };
}

// The kind of the section holding NAR offset `offset`, or NONE.
export function kindAt(table, offset) {
  const { starts, ends, kinds } = table;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo > 0 && offset < ends[lo - 1] ? kinds[lo - 1] : SectionKind.NONE;
}
