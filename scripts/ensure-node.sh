#!/usr/bin/env bash
# Source this file before pnpm start / pnpm start:client so the same Node
# version as package.json `engines` and `.nvmrc` is used (avoids better-sqlite3 ABI errors).
#   source ./scripts/ensure-node.sh
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh"
fi
if [ -f .nvmrc ]; then
    nvm use
else
    echo "No .nvmrc in $(pwd); add one or set Node 23.3.0 manually." >&2
    return 1
fi
node -v
