#!/bin/sh
# gitmancer one-file installer — curl | sh
# usage:  install.sh [version|branch]     (default: main)
#         GITMANCER_HOME=~/bin ./install.sh   → custom install dir
#         gitmancer uninstall             → remove
set -e

REPO="qtjg/gitmancer"
VERSION="${1:-main}"
DEST="${GITMANCER_HOME:-$HOME/.local/bin}"
URL="https://raw.githubusercontent.com/${REPO}/${VERSION}/gitmancer.js"

mkdir -p "$DEST"

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    echo "✖ need curl or wget" >&2
    exit 1
  fi
}

case "${1:-}" in
  uninstall|remove|--uninstall)
    rm -f "$DEST/gitmancer"
    echo "✔ gitmancer removed from $DEST"
    exit 0
    ;;
esac

TMP="$DEST/.gitmancer.tmp"
fetch "$URL" > "$TMP"

# sanity: file must be a node script, not a 404 page
head -n1 "$TMP" | grep -q "#!/usr/bin/env node" || {
  echo "✖ download failed (bad payload from $URL)" >&2
  rm -f "$TMP"
  exit 1
}

mv "$TMP" "$DEST/gitmancer"
chmod +x "$DEST/gitmancer"

echo "⚡ gitmancer ${VERSION} installed → $DEST/gitmancer"
node "$DEST/gitmancer" version 2>/dev/null || true
echo "next:"
echo "  gitmancer setup        # store your AI key + GitHub token"
echo "  gitmancer doctor       # verify everything works"
command -v gitmancer >/dev/null 2>&1 || echo "(add $DEST to your PATH if the command is not found)"
