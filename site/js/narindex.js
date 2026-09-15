// A streaming NAR indexer: fed an archive in chunks of any size, it
// records every entry and where each regular file's contents start,
// without keeping the contents. That offset is what maps a hovered byte
// to the file it belongs to.
//
// The NAR grammar: every token is a 64-bit little-endian length, the
// bytes, and zero padding to a multiple of 8.
//
//   archive   = "nix-archive-1" node
//   node      = "(" "type" ( regular | symlink | directory ) ")"
//   regular   = "regular" [ "executable" "" ] "contents" <bytes>
//   symlink   = "symlink" "target" <string>
//   directory = "directory" { "entry" "(" "name" <string> "node" node ")" }
//
// The grammar is a generator that yields what it needs next (read n bytes
// and hand them over, or skip n bytes), and push() satisfies those
// requests from whatever chunk has arrived, so a request may span any
// number of chunks.

import { INDEX_ENTRY_CAP } from "./config.js";

const PAD = 8;
const U64_BYTES = 8;
const MAGIC = "nix-archive-1";

// Names and symlink targets are short; a longer "token" means the bytes
// are not a NAR, and buffering it would only waste memory.
const MAX_TOKEN = 64 * 1024;

const Need = Object.freeze({ READ: "read", SKIP: "skip" });

export const EntryType = Object.freeze({
  REGULAR: "regular",
  SYMLINK: "symlink",
  DIRECTORY: "directory",
});

const EMPTY = new Uint8Array(0);

export class NarIndexer {
  constructor({ cap = INDEX_ENTRY_CAP } = {}) {
    this.cap = cap;
    this.entries = [];
    this.truncated = false;

    // Bytes consumed so far: the archive offset of the next byte.
    this.offset = 0;
    this.decoder = new TextDecoder();
    this.done = false;

    // A READ that spans chunks is assembled here.
    this.buffer = new Uint8Array(U64_BYTES);
    this.filled = 0;

    this.grammar = this.archive();
    this.request = null;
    this.advance(undefined);
  }

  // Feed the next piece of the archive.
  push(chunk) {
    let at = 0;
    while (at < chunk.length) {
      if (this.done) {
        throw new Error(`bad NAR: bytes after the end at ${this.offset}`);
      }

      const request = this.request;
      const take = Math.min(request.length - this.filled, chunk.length - at);

      // A skip only moves the offset.
      if (request.need === Need.SKIP) {
        this.filled += take;
        this.offset += take;
        at += take;
        if (this.filled === request.length) {
          this.filled = 0;
          this.advance(undefined);
        }
        continue;
      }

      // A read that fits in this chunk is handed over as a view; the
      // grammar decodes it before push() moves on, so the view is never
      // read after the chunk changes hands.
      if (this.filled === 0 && take === request.length) {
        this.offset += take;
        at += take;
        this.advance(chunk.subarray(at - take, at));
        continue;
      }

      // Otherwise assemble it across chunks.
      if (this.buffer.length < request.length) {
        this.buffer = new Uint8Array(request.length);
      }
      this.buffer.set(chunk.subarray(at, at + take), this.filled);
      this.filled += take;
      this.offset += take;
      at += take;
      if (this.filled === request.length) {
        this.filled = 0;
        this.advance(this.buffer.subarray(0, request.length));
      }
    }
  }

  // The index, once the whole archive has been pushed.
  finish() {
    if (!this.done) {
      throw new Error(`bad NAR: archive ends early at ${this.offset}`);
    }
    return { entries: this.entries, truncated: this.truncated };
  }

  // Resume the grammar with the value it asked for. A zero-length request
  // needs no bytes, so it is answered on the spot.
  advance(value) {
    for (;;) {
      const step = this.grammar.next(value);
      if (step.done) {
        this.done = true;
        this.request = null;
        return;
      }
      this.request = step.value;
      if (this.request.length > 0) {
        return;
      }
      value = EMPTY;
    }
  }

  record(entry) {
    if (this.entries.length >= this.cap) {
      this.truncated = true;
      return;
    }
    this.entries.push(entry);
  }

  *u64() {
    const bytes = yield { need: Need.READ, length: U64_BYTES };
    const view = new DataView(bytes.buffer, bytes.byteOffset, U64_BYTES);
    const lo = view.getUint32(0, true);
    const hi = view.getUint32(4, true);
    return hi * 2 ** 32 + lo;
  }

  *padding(length) {
    const pad = (PAD - (length % PAD)) % PAD;
    if (pad > 0) {
      yield { need: Need.SKIP, length: pad };
    }
  }

  *token() {
    const length = yield* this.u64();
    if (length > MAX_TOKEN) {
      throw new Error(`bad NAR: a ${length}-byte token at ${this.offset}`);
    }
    const bytes = yield { need: Need.READ, length };
    const text = this.decoder.decode(bytes);
    yield* this.padding(length);
    return text;
  }

  *expect(want) {
    const got = yield* this.token();
    if (got !== want) {
      throw new Error(
        `bad NAR: expected "${want}", got "${got}" at ${this.offset}`,
      );
    }
  }

  *archive() {
    yield* this.expect(MAGIC);
    yield* this.node("");
  }

  *node(path) {
    yield* this.expect("(");
    yield* this.expect("type");
    const type = yield* this.token();

    // A regular file: note where its contents start, then skip them.
    if (type === EntryType.REGULAR) {
      let token = yield* this.token();
      let executable = false;
      if (token === "executable") {
        executable = true;
        yield* this.expect("");
        token = yield* this.token();
      }
      if (token !== "contents") {
        throw new Error(`bad NAR: expected "contents", got "${token}"`);
      }
      const size = yield* this.u64();
      this.record({
        path,
        type,
        executable,
        contentOffset: this.offset,
        size,
        target: null,
      });
      if (size > 0) {
        yield { need: Need.SKIP, length: size };
      }
      yield* this.padding(size);
      yield* this.expect(")");
      return;
    }

    if (type === EntryType.SYMLINK) {
      yield* this.expect("target");
      const target = yield* this.token();
      this.record({
        path,
        type,
        executable: false,
        contentOffset: -1,
        size: 0,
        target,
      });
      yield* this.expect(")");
      return;
    }

    // A directory: its entries follow until the closing bracket.
    if (type === EntryType.DIRECTORY) {
      this.record({
        path,
        type,
        executable: false,
        contentOffset: -1,
        size: 0,
        target: null,
      });
      for (;;) {
        const token = yield* this.token();
        if (token === ")") {
          return;
        }
        if (token !== "entry") {
          throw new Error(`bad NAR: expected "entry", got "${token}"`);
        }
        yield* this.expect("(");
        yield* this.expect("name");
        const name = yield* this.token();
        yield* this.expect("node");
        yield* this.node(path === "" ? name : `${path}/${name}`);
        yield* this.expect(")");
      }
    }

    throw new Error(`bad NAR: unknown node type "${type}"`);
  }
}

// A lookup from archive offset to entry: the regular files' content
// starts in archive order, which is ascending.
export function buildFileLookup(entries) {
  const ids = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.type === EntryType.REGULAR && entry.size > 0) {
      ids.push(i);
    }
  }
  return {
    entries,
    ids: Int32Array.from(ids),
    starts: Float64Array.from(ids, (i) => entries[i].contentOffset),
  };
}

// The index of the entry whose contents hold `offset`, or -1 when the
// byte is NAR framing (tokens, names, padding).
export function fileAt(lookup, offset) {
  const { starts, ids, entries } = lookup;
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
  if (lo === 0) {
    return -1;
  }
  const id = ids[lo - 1];
  const entry = entries[id];
  return offset < entry.contentOffset + entry.size ? id : -1;
}
