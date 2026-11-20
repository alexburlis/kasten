#!/bin/sh
# build.sh <output.zip>: packs Kasten's sign-in page as a Stalwart application bundle. The server
# Dockerfile runs it. Stalwart caches every file except index.html for a year, so the script and
# the stylesheet get the first 12 hex digits of their SHA-256 in their names, and index.html
# names them so. The zip holds index.html, the two assets and stalwart-app.json.
set -eu

out=$1
case $out in /*) ;; *) out="$PWD/$out" ;; esac
src=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

page=$(cat "$src/index.html")

for name in signin.js signin.css; do
  hash=$(sha256sum "$src/$name" | cut -c1-12)
  hashed="${name%.*}-$hash.${name##*.}"
  cp "$src/$name" "$work/$hashed"
  case $page in
    *"\"$name\""*) ;;
    *) printf 'build.sh: index.html does not name %s\n' "$name" >&2; exit 1 ;;
  esac
  page=$(printf '%s\n' "$page" | sed "s|\"$name\"|\"$hashed\"|")
done

printf '%s\n' "$page" >"$work/index.html"
cp "$src/stalwart-app.json" "$work/stalwart-app.json"

# Stalwart rewrites exactly this text to <base href="/<prefix>/".
grep -q '<base href="/"' "$work/index.html" || { echo 'build.sh: index.html lost <base href="/"' >&2; exit 1; }

# Fixed timestamps and no extra attributes, so the same sources give the same zip.
find "$work" -type f -exec touch -t 198001010000 {} +
rm -f "$out"
(cd "$work" && zip -X -q "$out" index.html stalwart-app.json signin-*.js signin-*.css)
