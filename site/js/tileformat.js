// What the textures a tile is drawn from hold, shared by the tile worker
// that builds them and the renderer that samples them.
//
//   data  RGBA8, 256x256
//         LOD 0     R = the byte, A = entropy of its 256-byte chunk
//         LOD 1+    R, G, B = zero, ASCII and high-byte fractions,
//                   A = entropy (the summary record layout, summary.js)
//   ids   RG32UI, 256x256
//         R = path id at the texel's middle byte, NO_PATH for padding
//         G = file ordinal in that path's NAR (0 for framing or unknown),
//             with HAS_BYTES set when the texel's data was built from
//             bytes rather than left empty

export const NO_PATH = 0xffffffff;
export const HAS_BYTES = 0x80000000;
export const FILE_MASK = 0x7fffffff;

// The path table: one RGBA8 texel per path, RGB its package colour and A
// its state bits, wrapped at this width.
export const PATH_TABLE_WIDTH = 4096;

export const PathState = Object.freeze({
  SUMMARY: 1,
  RAW: 2,
  LOCAL: 4,
  FAILED: 8,
  LOADING: 16,
});

// Where a fetched NAR's raw bytes were kept.
export const RawStore = Object.freeze({
  OPFS: "opfs",
  MEMORY: "memory",
});
