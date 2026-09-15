# seenix

Every byte of a Nix closure, one pixel each: https://seenix.dev

Give it a store path, a nixpkgs package, or the output of
`nix path-info -r --json`, and it lays every store path's NAR out along a
Hilbert curve and lets you pan and zoom around it like a map. Zoomed out
you see which packages take the space; zoomed in you see the texture of
code, strings and compressed data; all the way in you read the bytes
in hex, with the file, the ELF section and any store path they name.
Nothing runs on a server.

## Life of a map

1. The closure is walked from narinfos on cache.nixos.org and any extra
   caches in the link, and every signature is checked against the
   configured keys. An imported `path-info` JSON skips the walk and asks
   the caches where each path's NAR is instead.
2. Paths are sorted by name, root first, and placed end to end on the
   curve. A world of order N is 2^N × 2^N pixels, and any aligned block
   of it is one contiguous byte range, so a tile is just a byte range and
   the layout needs no NAR at all.
3. As you zoom in, the NARs on screen are fetched by a pool of workers,
   decompressed as they stream (xz, zstd or bzip2, depending on the
   path's age), hashed, indexed, summarised and scanned for store-path
   references in one pass. The raw bytes go to the browser's origin
   private file system, and the summaries to IndexedDB, so a map seen
   once loads from disk next time.
4. A tile worker builds each tile's textures from those summaries or the
   raw bytes, and one WebGL2 shader draws every colour mode, so
   switching modes rebuilds nothing.

Downloads are polite to the cache: nothing is fetched until you zoom in,
and only while what is on screen stays under 64 MiB; beyond that the
toolbar offers to fetch it.

The URL is the state: roots, extra caches with their keys, the colour
mode, the pinned path and the view all live in the query string.

## Your own closure

```console
$ nix path-info -r --json /run/current-system > closure.json
```

Drop the file on the map. Paths that no configured cache holds are drawn
hatched in grey. To fill those in, serve your local store over HTTP with
CORS headers (harmonia behind a proxy that adds
`Access-Control-Allow-Origin`) and add it in the Caches lane.

## Layout

`site/` is the static site: vanilla ES modules and module workers, no
bundler. `site/js/workers/` holds the NAR, tile and graph workers.
`nix/` holds the flake's pieces: `site.nix` assembles the deployable
tree, `vendor.nix` pins the decoders and hash-wasm, `example.nix` is the
two-cache example published to seenix.cachix.org, and `formatter.nix`
is `nix fmt`. `tests/` is the node test suite, which runs offline
against real NARs and `path-info` output.

## Running

```console
$ nix run .#serve         # build the site and serve it on :8138
$ nix flake check         # tests, and the site assembles
$ nix fmt                 # before committing
```

To iterate without rebuilding, link the vendored dependencies into the
checkout and serve `site/` directly:

```console
$ ln -s "$(nix build .#vendor --print-out-paths)" site/vendor
$ SEENIX_SITE=$PWD/site nix run .#serve
```

The site is deployed by GitHub Actions from `nix build .#site`.

## Credits

- [binvis.io](https://binvis.io) and Aldo Cortesi's writing on
  visualising binaries with space-filling curves.
- [xzwasm](https://github.com/SteveSanderson/xzwasm),
  [fzstd](https://github.com/101arrowz/fzstd),
  [crabz2](https://www.npmjs.com/package/crabz2) and
  [hash-wasm](https://github.com/Daninet/hash-wasm).
- [nixpkgs-multiverse](https://github.com/fzakaria/nixpkgs-multiverse)
  for naming store paths.

## License

MIT, please see [LICENSE](LICENSE).
