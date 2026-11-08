#!/bin/sh
# Build node-pty's native module (pty.node) for Linux and put it where node-pty looks for it.
#
# node-pty ships prebuilt binaries for macOS and Windows only; on Linux it compiles at install
# time, and Deno does not run npm install scripts without a node_modules directory. So build it
# with npm in a temp dir (needs node, npm, python3, make and a C++ compiler) and copy the result
# into the package's own directory in Deno's npm cache, as build/Release/pty.node (the first
# place node-pty's loader checks). It is a Node-API module, so Deno loads it as is.
#
#   sh scripts/build-node-pty-linux.sh
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Linux ] || { echo "Linux only (macOS and Windows use node-pty's prebuilds)."; exit 0; }

VER="$(deno eval 'console.log(JSON.parse(Deno.readTextFileSync("deno.json")).imports["node-pty"].replace(/^npm:node-pty@/, ""))')"
deno cache desktop/pty.ts >/dev/null
NPM_CACHE="$(deno info --json | deno eval 'console.log(JSON.parse(await new Response(Deno.stdin.readable).text()).npmCache)')"
PKG="$NPM_CACHE/registry.npmjs.org/node-pty/$VER"
[ -d "$PKG" ] || { echo "node-pty $VER is not in Deno's npm cache ($NPM_CACHE)" >&2; exit 1; }

# A distro Node (Debian/Ubuntu's `nodejs` package) is a shared libnode, and node-gyp links the
# addon to it: that pty.node loads where the distro Node is installed (deno run on this machine)
# but not in a packaged app on one without it ("libnode.so.109: cannot open shared object file").
# A packaged build needs nodejs.org's Node (GitHub's runners have it, and so do nvm, fnm, volta).
links_libnode() { grep -q 'libnode\.so' "$1"; }

if [ -f "$PKG/build/Release/pty.node" ]; then
  if ! links_libnode "$PKG/build/Release/pty.node"; then
    echo "node-pty $VER: build/Release/pty.node already present"
    exit 0
  fi
  echo "node-pty $VER: the cached pty.node links a shared libnode; rebuilding it"
  rm -f "$PKG/build/Release/pty.node"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Building node-pty $VER for $(uname -m)…"
(cd "$TMP" && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error "node-pty@$VER")
[ -f "$TMP/node_modules/node-pty/build/Release/pty.node" ] || { echo "the build produced no pty.node" >&2; exit 1; }
if links_libnode "$TMP/node_modules/node-pty/build/Release/pty.node"; then
  echo "pty.node links $(command -v node)'s shared libnode: a packaged app could not load it." >&2
  echo "Use nodejs.org's Node (or nvm / fnm / volta), not the distro's nodejs package." >&2
  exit 1
fi
mkdir -p "$PKG/build/Release"
cp "$TMP/node_modules/node-pty/build/Release/pty.node" "$PKG/build/Release/pty.node"
echo "Installed $PKG/build/Release/pty.node"
