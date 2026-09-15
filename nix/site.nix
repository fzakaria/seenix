# `nix build .#site` — the whole deployable tree, so the pages workflow
# only has to upload what nix built:
#
#   index.html, style.css, js.<hash>/   the site itself, workers included
#   vendor/                             pinned browser dependencies
#
# There is no service worker and no COOP/COEP: nothing here shares
# memory between threads, so the page does not need cross-origin
# isolation, and GitHub Pages serves it as is.
{ pkgs }:
let
  vendor = import ./vendor.nix { inherit pkgs; };
in
pkgs.runCommand "seenix-site" { } ''
  mkdir -p $out
  # The site directory alone, rather than a subpath of the whole flake
  # source, so a change to a test or a doc does not rebuild the site.
  cp -r ${../site}/. $out/
  chmod -R u+w $out
  rm -rf $out/vendor
  cp -r ${vendor} $out/vendor
  chmod -R u+w $out/vendor

  # The footer names the store path serving the page, the same benign
  # self-reference trynix and the multiverse make.
  substituteInPlace $out/js/app.js --replace-fail "__STORE_PATH__" "$out"

  # trynix's cache-busting trick: hash the module tree and rename it
  # js.<hash>, so the served HTML and every module and worker it pulls
  # in can never be a mismatched pair across deploys. Modules and
  # workers load each other by relative URL, and vendor/ is reached as
  # ../vendor from inside the tree, so the rename breaks nothing.
  hash=$(find $out/js -type f | LC_ALL=C sort |
    xargs sha256sum | sha256sum | cut -c1-12)
  mv $out/js "$out/js.$hash"
  substituteInPlace $out/index.html --replace-fail "js/app.js" "js.$hash/app.js"

  # The stylesheet is fetched by a fixed name, so its content hash rides
  # as a query string instead.
  css=$(sha256sum $out/style.css | cut -c1-12)
  substituteInPlace $out/index.html --replace-fail '"style.css"' "\"style.css?v=$css\""
''
