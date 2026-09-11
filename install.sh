#!/bin/sh
# gitmancer one-file installer — curl | sh
set -e
DEST="${GITMANCER_HOME:-$HOME/.local/bin}"
mkdir -p "$DEST"
curl -fsSL https://raw.githubusercontent.com/qtjg/gitmancer/main/gitmancer.js -o "$DEST/gitmancer"
chmod +x "$DEST/gitmancer"
echo "⚡ gitmancer installed → $DEST/gitmancer"
echo "next: gitmancer setup"
command -v gitmancer >/dev/null 2>&1 || echo "(add $DEST to your PATH)"
