#!/usr/bin/env bash
# Build Loft and install it into an Obsidian vault.
#
# Usage:  ./install.sh [path-to-vault]
# Default vault: iCloud "Personal" (override with the argument or $OBSIDIAN_VAULT).
set -euo pipefail

DEFAULT_VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Personal"
VAULT="${1:-${OBSIDIAN_VAULT:-$DEFAULT_VAULT}}"

cd "$(dirname "$0")"
PLUGIN_ID="$(node -p "require('./manifest.json').id")"
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "error: '$VAULT' is not an Obsidian vault (no .obsidian folder)." >&2
  echo "Pass the vault path as an argument: ./install.sh \"/path/to/vault\"" >&2
  exit 1
fi

[ -d node_modules ] || npm ci
npm run build

mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"

echo "Installed $PLUGIN_ID to: $DEST"
echo "In Obsidian: Settings → Community plugins → reload, then enable \"Loft\"."
echo "(Already enabled? Run the command \"Reload app without saving\".)"
