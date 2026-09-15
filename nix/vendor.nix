# Vendored browser dependencies, pinned by hash and served same-origin.
#
# Every one of these is loaded as an ES module, because the NAR workers
# are module workers: crabz2 is an ES module that finds its wasm through
# import.meta.url, and a classic worker cannot import it. xzwasm and
# fzstd ship only UMD bundles, so each is wrapped in a module that hands
# the bundle a CommonJS `module` to fill and exports what it put there.
# The same wrapped files load in node, which is what lets the test suite
# drive the real decoders.
#
# The pins for xzwasm, fzstd and crabz2 are trynix's (nix/vendor.nix
# there), including the xzwasm patch. hash-wasm adds an incremental
# sha256, so a NAR's hash is checked as it streams rather than after
# holding the whole archive.
{ pkgs }:
let
  npm =
    name: version: sha256:
    pkgs.fetchurl {
      url = "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz";
      inherit sha256;
    };

  xzwasm = npm "xzwasm" "0.1.2" "18zc8z5hfy34cy3z7a5baz07hccl2y0y17y7qsxiy4wsw8v6ig7n";
  fzstd = npm "fzstd" "0.1.1" "1ia5gjcs9r9pfj4jqd3jac233a08qy9342fh27i7n1ir6hnyxljy";
  crabz2 = npm "crabz2" "0.4.0" "1iy7ihsc536zqbjkysh11l55sxk2mb5ibbpf5b7jpn0md84ws3p1";
  hashWasm = npm "hash-wasm" "4.12.0" "14kgb3mqhzb53dhxddfczaylw8fq7j6l7b685s9pfqdlbw92mcqx";
in
pkgs.runCommand "seenix-js-vendor" { } ''
  mkdir -p $out unpack

  # Wrap a UMD bundle as an ES module. The bundle sees a CommonJS
  # `module` and `exports`, takes its CommonJS branch, and the wrapper
  # exports the result as the module's default. xzwasm's webpack header
  # also names `self` as its root, which node does not define, so the
  # module binds it to globalThis (the same object in a page or worker).
  wrap() {
    {
      echo 'const self = globalThis;'
      echo 'const module = { exports: {} };'
      echo 'const exports = module.exports;'
      cat "$1"
      echo
      echo 'export default module.exports;'
    } > "$2"
  }

  # The readable build rather than the minified one, so the patch
  # applies: patches/xzwasm/ makes the decoder copy each chunk out of
  # its own memory before handing it on. Streaming makes the bug the
  # patch fixes more likely, since a consumer that is still hashing the
  # previous chunk is exactly the one that reads overwritten bytes.
  tar -xzf ${xzwasm} -C unpack
  cp unpack/package/dist/package/xzwasm.js xzwasm.js
  chmod u+w xzwasm.js
  for patch in ${../patches/xzwasm}/*.patch; do
    patch -p1 < "$patch"
  done
  wrap xzwasm.js $out/xzwasm.js
  rm -r unpack/package

  tar -xzf ${fzstd} -C unpack
  wrap unpack/package/umd/index.js $out/fzstd.js
  rm -r unpack/package

  # The wasm sits beside the module, which is where the wasm-bindgen
  # glue looks for it.
  tar -xzf ${crabz2} -C unpack
  cp unpack/package/crabz2.js unpack/package/crabz2_bg.wasm $out/
  rm -r unpack/package

  # Already an ES module, with its wasm inlined.
  tar -xzf ${hashWasm} -C unpack
  cp unpack/package/dist/index.esm.min.js $out/hash-wasm.js
  rm -r unpack/package
''
