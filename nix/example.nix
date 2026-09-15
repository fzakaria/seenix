# A small program published to seenix.cachix.org whose dependencies,
# glibc and zlib, come from cache.nixos.org: one closure drawn from two
# caches, for the landing page.
{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "seenix-example";
  version = "1";
  src = ./example;
  buildInputs = [ pkgs.zlib ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -o seenix-example main.c -lz
    runHook postBuild
  '';

  # The source rides along, so the map has a text region next to the ELF.
  installPhase = ''
    runHook preInstall
    install -Dm755 seenix-example $out/bin/seenix-example
    install -Dm644 main.c $out/share/seenix-example/main.c
    runHook postInstall
  '';
}
