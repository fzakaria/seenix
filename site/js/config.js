// Site-wide constants.

// The binary cache the closure walk and NAR fetches read from first.
export const CACHE_URL = "https://cache.nixos.org";

// The nixpkgs-multiverse index, served from GitHub Pages with open
// CORS. `?pkg=` resolves against it, and the legend names a store path
// with it.
export const MULTIVERSE_URL = "https://nixmultiverse.com";
export const SYSTEM = "x86_64-linux";
export const MULTIVERSE_SITE_SYSTEM = "x86_64-linux";

// A store path is <store dir>/<digest>-<name>; the digest is 32
// characters of nix base32.
export const STORE_DIR = "/nix/store";
export const DIGEST_LENGTH = 32;
export const DIGEST_PATTERN = /^[0-9abcdfghijklmnpqrsvwxyz]{32}$/;

// How many narinfo fetches fly at once during a closure walk. The bound
// exists for the browser's connection queue, not for the cache.
export const FETCH_CONCURRENCY = 20;

// How many NARs download and decode at once, one per worker. Each worker
// has its own wasm memory and every stage streams, so a worker's peak
// memory is bounded by chunk sizes rather than by NAR size.
export const NAR_WORKERS = 3;

// How many workers build tile textures.
export const TILE_WORKERS = 2;

// A tile is 256 texels square: 2^8, so one tile at LOD 0 is one aligned
// block of 4^8 bytes on the curve.
export const TILE_ORDER = 8;
export const TILE_SIZE = 2 ** TILE_ORDER;

// The smallest world is one tile.
export const MIN_ORDER = TILE_ORDER;

// The two summary granularities, both aligned to the start of a path's
// own NAR so a summary depends only on the NAR hash.
//
// Coarse chunks (4096 bytes, one LOD-6 texel) are small enough to keep
// forever in IndexedDB. Fine chunks (256 bytes) are sixteen times larger
// and live next to the raw NAR on disk, evicted with it.
export const COARSE_CHUNK = 4096;
export const FINE_CHUNK = 256;
export const SUMMARY_RECORD = 4;

// Which source each LOD reads. A texel at LOD k covers 4^k bytes.
//
//   LOD 0-3   raw bytes          a tile reads at most 4 MiB of NAR
//   LOD 4-5   fine summaries     a tile reads at most 1 MiB of records
//   LOD 6+    coarse summaries   prefix sums held in the tile worker
export const LOD_FINE = 4;
export const LOD_COARSE = 6;

// NARs are fetched without asking only once the view is zoomed in to
// LOD 6 or closer, and only while what the viewport still needs fits
// under this many compressed bytes. Anything bigger waits for the reader
// to press "Fetch visible": cache.nixos.org is donated infrastructure,
// and a closure fit to the screen is otherwise gigabytes on page load.
export const AUTO_FETCH_LOD = LOD_COARSE;
export const AUTO_FETCH_BYTES = 64 * 1024 * 1024;

// A download whose path has been off screen this long, and is less than
// this far along, is aborted.
export const ABORT_OFFSCREEN_MS = 2000;
export const ABORT_BELOW_FRACTION = 0.5;

// Raw NAR budget on disk, and the in-memory fallback when OPFS is not
// available (some private windows).
export const RAW_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
export const MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

// Caps on what is recorded per path.
export const INDEX_ENTRY_CAP = 100_000;
export const REF_HIT_CAP = 10_000;

// How many tiles keep GPU textures, and how many LOD-0 tiles keep their
// bytes on the main thread for the hex overlay.
export const GPU_TILE_CACHE = 192;
export const CPU_TILE_CACHE = 32;

// How often a worker reports progress on one path.
export const PROGRESS_INTERVAL_MS = 100;

// Store paths for the landing page, each checked on 2026-09-15 to
// resolve on cache.nixos.org. The package paths are nixos-unstable's
// x86_64-linux outputs; the two systems are Hydra's
// nixos:trunk-combined nixos.closures jobs from evaluation 1829163.
//
// A featured closure may name its own cache with `cache` ("url key",
// the same format as ?cache=), for paths a seenix cachix holds.
export const FEATURED = [
  {
    label: "hello",
    path: "/nix/store/xl1h9i29pgq2q5cszjhm5wpfxfbbqwyi-hello-2.12.3",
  },
  {
    label: "ripgrep",
    path: "/nix/store/hkclq7d0j10l7gk1v2hpif398dvnq6lz-ripgrep-15.2.0",
  },
  {
    label: "git",
    path: "/nix/store/msr1v91ybfw6j12rs5mfl8ghb2rqsnsr-git-2.55.0",
  },
  {
    label: "python 3.14",
    path: "/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7",
  },
  {
    label: "firefox",
    path: "/nix/store/5l9n8bw1wifj5kdr8gzlrkk1b510dfiv-firefox-155.0.1",
  },
  {
    label: "a minimal NixOS container",
    path: "/nix/store/4dps9w9kwa6kbgwiil24kqi10i699ydi-nixos-system-nixos-26.11pre1074086.efe6f071ede9",
  },
  {
    label: "a GNOME desktop",
    path: "/nix/store/5ryb0d1a261bgvxqqd436yx8i7j44qlc-nixos-system-nixos-26.11pre1074086.efe6f071ede9",
  },
];
