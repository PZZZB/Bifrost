#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_directory"
export CODEX_BINARY="${CODEX_BINARY:-$(command -v codex)}"
exec node src/main.mjs
