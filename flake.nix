{
  description = "Pan around a Nix closure, one byte per pixel";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  # The example closure is published here; its dependencies are
  # cache.nixos.org's.
  nixConfig = {
    extra-substituters = [ "https://seenix.cachix.org" ];
    extra-trusted-public-keys = [
      "seenix.cachix.org-1:J3smIV60apuKqx9is7E+VWO1EQpLnaWVv4O37CxWkHY="
    ];
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          # the static site: everything the pages workflow deploys and
          # `nix run .#serve` tests locally
          site = import ./nix/site.nix { inherit pkgs; };
          default = site;

          # the pinned browser dependencies on their own, for linking into
          # a checkout as site/vendor while working on it
          # (`ln -s "$(nix build .#vendor --print-out-paths)" site/vendor`)
          vendor = import ./nix/vendor.nix { inherit pkgs; };

          # the two-cache example on the landing page, pushed to
          # seenix.cachix.org (nix/example.nix)
          example = import ./nix/example.nix { inherit pkgs; };
        }
      );

      apps = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # serve the built site, exactly the tree pages deploys.
          # `nix run .#serve -- <port>` overrides the default 8138.
          # no-store because store paths carry a 1970 mtime, and a 304
          # would keep a previous build's JS forever. $SEENIX_SITE serves a
          # checkout's site/ directory instead, for iterating without a
          # rebuild (it needs site/vendor linked, see packages.vendor).
          serve = {
            type = "app";
            program = "${pkgs.writeShellScript "serve-site" ''
              exec ${pkgs.python3}/bin/python3 - "''${1:-8138}" <<'EOF'
              import http.server, os, sys, urllib.parse

              SITE = os.environ.get("SEENIX_SITE") or "${self.packages.${system}.site}"

              class Handler(http.server.SimpleHTTPRequestHandler):
                  def translate_path(self, path):
                      path = urllib.parse.urlparse(path).path
                      if path == "/":
                          path = "/index.html"
                      return os.path.join(SITE, path.lstrip("/"))

                  def end_headers(self):
                      self.send_header("Cache-Control", "no-store")
                      super().end_headers()

              http.server.SimpleHTTPRequestHandler.extensions_map[".js"] = "text/javascript"
              http.server.SimpleHTTPRequestHandler.extensions_map[".wasm"] = "application/wasm"
              port = int(sys.argv[1])
              print(f"serving on http://127.0.0.1:{port}/ (site={SITE})", flush=True)
              http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
              EOF
            ''}";
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          vendor = self.packages.${system}.vendor;
        in
        {
          # the site assembles: the entry page, the hashed module tree and
          # its workers are where the build put them
          site = pkgs.runCommand "seenix-site-check" { } ''
            test -f ${self.packages.${system}.site}/index.html
            test -f ${self.packages.${system}.site}/js.*/app.js
            test -f ${self.packages.${system}.site}/js.*/workers/nar-worker.js
            test -f ${self.packages.${system}.site}/vendor/xzwasm.js
            touch $out
          '';

          # The node test suite, offline. A writable copy of the tree
          # rather than the source itself, so the vendored dependencies can
          # be put where the site's modules import them from, which is what
          # lets the decoder tests drive the real decoders.
          tests = pkgs.runCommand "seenix-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            cp -r ${self} tree
            chmod -R u+w tree
            cd tree
            rm -rf site/vendor
            ln -s ${vendor} site/vendor
            node --test tests/site/*.test.mjs
            touch $out
          '';
        }
      );

      formatter = forAllSystems (
        system:
        import ./nix/formatter.nix {
          pkgs = nixpkgs.legacyPackages.${system};
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.jq
            ];
          };
        }
      );
    };
}
