#!/usr/bin/env bash
# Installs cloudflared to ~/.local/bin — no sudo, no card, $0.
set -euo pipefail
mkdir -p "$HOME/.local/bin"
cd "$(mktemp -d)"
curl -fsSL -o cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared
mv cloudflared "$HOME/.local/bin/cloudflared"
"$HOME/.local/bin/cloudflared" --version
echo "installed. If 'cloudflared' is not on PATH, add \$HOME/.local/bin to PATH."
