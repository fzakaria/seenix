// Finding store-path references in a NAR the way Nix does: any 32 bytes
// drawn from the nix base32 alphabet that spell the digest of a path in
// the closure. Each hit records where in the NAR the digest starts and
// which path it names, for the tooltip and the reference overlay.
//
// The scanner keeps the last 32 alphabet bytes in a ring, so a digest
// that straddles a chunk boundary is still found.

import { DIGEST_LENGTH, REF_HIT_CAP } from "./config.js";

const ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const IN_ALPHABET = new Uint8Array(256);
for (const c of ALPHABET) {
  IN_ALPHABET[c.charCodeAt(0)] = 1;
}

export class RefScanner {
  // `digests` maps a digest to its path id.
  constructor(digests, { cap = REF_HIT_CAP } = {}) {
    this.digests = digests;
    this.cap = cap;
    this.hits = [];
    this.truncated = false;
    this.ring = new Uint8Array(DIGEST_LENGTH);
    this.run = 0;
    this.offset = 0;
  }

  push(chunk) {
    const ring = this.ring;
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (IN_ALPHABET[b] === 0) {
        this.run = 0;
        continue;
      }

      // Remember the byte at its position modulo the ring size.
      const position = this.offset + i;
      const slot = position % DIGEST_LENGTH;
      ring[slot] = b;
      this.run += 1;
      if (this.run < DIGEST_LENGTH) {
        continue;
      }

      // The last 32 bytes are all alphabet: check them against the
      // closure. The oldest of them sits in the slot after this one.
      let text = "";
      for (let k = 1; k <= DIGEST_LENGTH; k += 1) {
        text += String.fromCharCode(ring[(slot + k) % DIGEST_LENGTH]);
      }
      const target = this.digests.get(text);
      if (target === undefined) {
        continue;
      }
      if (this.hits.length >= this.cap) {
        this.truncated = true;
        continue;
      }
      this.hits.push({ offset: position - DIGEST_LENGTH + 1, target });
    }
    this.offset += chunk.length;
  }

  finish() {
    return { hits: this.hits, truncated: this.truncated };
  }
}

// The hit covering a NAR offset, or null. Hits are in ascending offset
// order, as the scanner found them.
export function refAt(hits, offset) {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (hits[mid].offset <= offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo === 0) {
    return null;
  }
  const hit = hits[lo - 1];
  return offset < hit.offset + DIGEST_LENGTH ? hit : null;
}
