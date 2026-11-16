#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
workspace="$root/."
mkdir -p "$here/wasm"
cd "$workspace"
RUSTUP_TOOLCHAIN=1.95.0 stellar contract build --locked --package alloy-nav --out-dir "$here/wasm"
