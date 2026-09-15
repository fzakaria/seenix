// Naming the ELF section a byte belongs to. Little-endian ELF64 only,
// which is every x86_64-linux and aarch64-linux binary in nixpkgs;
// anything else is reported as unsupported rather than misread.
//
// Reads go through `readAt(offset, length)`, which resolves to the bytes
// of the file at that offset, so only the header, the section header
// table and the name table are ever read.

const MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const EI_CLASS = 4;
const EI_DATA = 5;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;

const HEADER_SIZE = 64;
const E_SHOFF = 0x28;
const E_SHENTSIZE = 0x3a;
const E_SHNUM = 0x3c;
const E_SHSTRNDX = 0x3e;

const SECTION_HEADER_SIZE = 64;
const SH_NAME = 0x00;
const SH_TYPE = 0x04;
const SH_FLAGS = 0x08;
const SH_ADDR = 0x10;
const SH_OFFSET = 0x18;
const SH_SIZE = 0x20;

// A section that occupies no bytes in the file (.bss).
const SHT_NOBITS = 8;

// Bounds on what a corrupt header can make this read.
const MAX_SECTIONS = 4096;
const MAX_NAME_TABLE = 1024 * 1024;

export const ELF_MAGIC = Uint8Array.from(MAGIC);

// Whether bytes start with the ELF magic.
export const isElf = (bytes) =>
  bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);

// { ok: true, sections: [{ name, type, flags, addr, offset, size }] } or
// { ok: false, reason }.
export async function readElfSections(readAt) {
  const header = await readAt(0, HEADER_SIZE);
  if (header.length < HEADER_SIZE || !isElf(header)) {
    return { ok: false, reason: "not an ELF file" };
  }
  if (header[EI_CLASS] !== ELFCLASS64) {
    return { ok: false, reason: "ELF (unsupported: 32-bit)" };
  }
  if (header[EI_DATA] !== ELFDATA2LSB) {
    return { ok: false, reason: "ELF (unsupported: big-endian)" };
  }

  const view = new DataView(header.buffer, header.byteOffset, HEADER_SIZE);
  const tableOffset = Number(view.getBigUint64(E_SHOFF, true));
  const entrySize = view.getUint16(E_SHENTSIZE, true);
  const count = Math.min(view.getUint16(E_SHNUM, true), MAX_SECTIONS);
  const nameIndex = view.getUint16(E_SHSTRNDX, true);
  if (count === 0 || entrySize < SECTION_HEADER_SIZE) {
    return { ok: true, sections: [] };
  }

  // The section header table.
  const table = await readAt(tableOffset, count * entrySize);
  if (table.length < count * entrySize) {
    return { ok: false, reason: "ELF section headers run past the file" };
  }
  const tableView = new DataView(table.buffer, table.byteOffset, table.length);
  const sections = [];
  for (let i = 0; i < count; i += 1) {
    const at = i * entrySize;
    sections.push({
      nameOffset: tableView.getUint32(at + SH_NAME, true),
      type: tableView.getUint32(at + SH_TYPE, true),
      flags: Number(tableView.getBigUint64(at + SH_FLAGS, true)),
      addr: Number(tableView.getBigUint64(at + SH_ADDR, true)),
      offset: Number(tableView.getBigUint64(at + SH_OFFSET, true)),
      size: Number(tableView.getBigUint64(at + SH_SIZE, true)),
    });
  }

  // The names, out of the section-name string table.
  const nameTable = sections[nameIndex];
  const names =
    nameTable === undefined
      ? new Uint8Array(0)
      : await readAt(
          nameTable.offset,
          Math.min(nameTable.size, MAX_NAME_TABLE),
        );
  const decoder = new TextDecoder();
  for (const section of sections) {
    const end = names.indexOf(0, section.nameOffset);
    section.name =
      section.nameOffset < names.length
        ? decoder.decode(
            names.subarray(section.nameOffset, end === -1 ? names.length : end),
          )
        : "";
    delete section.nameOffset;
  }

  return { ok: true, sections };
}

// The smallest section whose file bytes hold `offset`, or null (the ELF
// header, program headers, or the gaps between sections).
export function sectionAt(sections, offset) {
  let best = null;
  for (const section of sections) {
    if (section.type === SHT_NOBITS || section.size === 0) {
      continue;
    }
    if (offset < section.offset || offset >= section.offset + section.size) {
      continue;
    }
    if (best === null || section.size < best.size) {
      best = section;
    }
  }
  return best;
}
