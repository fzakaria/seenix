// Byte summaries: for each consecutive run of bytes of a path's NAR, four
// bytes describing it.
//
//   byte 0   fraction of 0x00 bytes                          x 255
//   byte 1   fraction of printable ASCII (0x20-0x7e, \t \n \r) x 255
//   byte 2   fraction of high bytes (0x80-0xff)              x 255
//   byte 3   Shannon entropy, bits per byte                  x 255 / 8
//
// The remaining class, low control bytes, is 255 minus the first three.
// Runs are aligned to the start of the path's own NAR, so a summary
// depends only on the NAR hash and two closures sharing glibc share its
// summaries. One pass builds both granularities (config.js says where
// each is used).

import { COARSE_CHUNK, FINE_CHUNK, SUMMARY_RECORD } from "./config.js";

export const Field = Object.freeze({ ZERO: 0, ASCII: 1, HIGH: 2, ENTROPY: 3 });

const MAX = 255;
const BITS_PER_BYTE = 8;
const BYTE_VALUES = 256;

// Every byte value's class.
const ByteClass = Object.freeze({ ZERO: 0, ASCII: 1, HIGH: 2, CONTROL: 3 });
const CLASS_COUNT = 4;
const TAB = 0x09;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const PRINTABLE_FIRST = 0x20;
const PRINTABLE_LAST = 0x7e;
const HIGH_FIRST = 0x80;

const CLASS_OF = new Uint8Array(BYTE_VALUES).map((_, b) => {
  if (b === 0) {
    return ByteClass.ZERO;
  }
  if (b >= HIGH_FIRST) {
    return ByteClass.HIGH;
  }
  if (
    (b >= PRINTABLE_FIRST && b <= PRINTABLE_LAST) ||
    b === TAB ||
    b === NEWLINE ||
    b === RETURN
  ) {
    return ByteClass.ASCII;
  }
  return ByteClass.CONTROL;
});

// c * log2(c) for every count a chunk can hold, so entropy is table
// lookups rather than logarithms.
const XLOGX = new Float64Array(COARSE_CHUNK + 1).map((_, c) =>
  c === 0 ? 0 : c * Math.log2(c),
);

// One granularity's running chunk and its finished records.
class Accumulator {
  constructor(chunkSize, expectedBytes) {
    this.chunkSize = chunkSize;
    this.histogram = new Uint32Array(BYTE_VALUES);
    this.classes = new Uint32Array(CLASS_COUNT);
    this.count = 0;
    const records = Math.max(1, Math.ceil(expectedBytes / chunkSize));
    this.records = new Uint8Array(records * SUMMARY_RECORD);
    this.written = 0;
  }

  // Write the current chunk's record and start the next.
  flush() {
    const n = this.count;
    if (n === 0) {
      return;
    }

    // Grow when the stream runs past what was expected.
    if (this.written + SUMMARY_RECORD > this.records.length) {
      const grown = new Uint8Array(this.records.length * 2);
      grown.set(this.records);
      this.records = grown;
    }

    let sum = 0;
    for (let b = 0; b < BYTE_VALUES; b += 1) {
      sum += XLOGX[this.histogram[b]];
    }
    const entropy = Math.log2(n) - sum / n;

    const out = this.records;
    const at = this.written;
    out[at + Field.ZERO] = Math.round((this.classes[ByteClass.ZERO] * MAX) / n);
    out[at + Field.ASCII] = Math.round(
      (this.classes[ByteClass.ASCII] * MAX) / n,
    );
    out[at + Field.HIGH] = Math.round((this.classes[ByteClass.HIGH] * MAX) / n);
    out[at + Field.ENTROPY] = Math.round((entropy * MAX) / BITS_PER_BYTE);
    this.written += SUMMARY_RECORD;

    this.histogram.fill(0);
    this.classes.fill(0);
    this.count = 0;
  }

  result() {
    return this.records.slice(0, this.written);
  }
}

export class SummaryBuilder {
  // `expectedBytes`, when known, sizes the record buffers up front.
  constructor(expectedBytes = COARSE_CHUNK) {
    this.coarse = new Accumulator(COARSE_CHUNK, expectedBytes);
    this.fine = new Accumulator(FINE_CHUNK, expectedBytes);
  }

  push(chunk) {
    const coarse = this.coarse;
    const fine = this.fine;
    let at = 0;

    // Run up to the next boundary of either granularity, then flush the
    // ones that filled. The fine size divides the coarse size, so the
    // fine boundary always comes first or together.
    while (at < chunk.length) {
      const room = Math.min(
        fine.chunkSize - fine.count,
        coarse.chunkSize - coarse.count,
        chunk.length - at,
      );
      const end = at + room;
      const fh = fine.histogram;
      const fc = fine.classes;
      const ch = coarse.histogram;
      const cc = coarse.classes;
      for (let i = at; i < end; i += 1) {
        const b = chunk[i];
        const k = CLASS_OF[b];
        fh[b] += 1;
        fc[k] += 1;
        ch[b] += 1;
        cc[k] += 1;
      }
      fine.count += room;
      coarse.count += room;
      at = end;

      if (fine.count === fine.chunkSize) {
        fine.flush();
      }
      if (coarse.count === coarse.chunkSize) {
        coarse.flush();
      }
    }
  }

  // { coarse, fine }: one record per chunk, the last one describing only
  // the bytes it held.
  finish() {
    this.coarse.flush();
    this.fine.flush();
    return { coarse: this.coarse.result(), fine: this.fine.result() };
  }
}

// The low-control fraction of record i, x 255.
export function controlFraction(records, i) {
  const at = i * SUMMARY_RECORD;
  const rest =
    MAX -
    records[at + Field.ZERO] -
    records[at + Field.ASCII] -
    records[at + Field.HIGH];
  return Math.max(0, rest);
}
