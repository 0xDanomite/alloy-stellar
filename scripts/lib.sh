#!/usr/bin/env bash
# Shared helpers for the Alloy CLI scripts. Source, do not run.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

NETWORK="${NETWORK:-testnet}"
ADMIN_IDENTITY="${ADMIN_IDENTITY:-alloy-admin}"
MANAGER_IDENTITY="${MANAGER_IDENTITY:-alloy-manager}"
INVESTOR_IDENTITY="${INVESTOR_IDENTITY:-alloy-investor}"
DEMO_ISSUER_IDENTITY="${DEMO_ISSUER_IDENTITY:-alloy-demo-issuer}"

case "$NETWORK" in
  testnet)
    export STELLAR_RPC_URL="${TESTNET_RPC_URL:-https://soroban-testnet.stellar.org}"
    export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
    HORIZON_URL="https://horizon-testnet.stellar.org"
    EXPERT="https://stellar.expert/explorer/testnet"
    ;;
  mainnet)
    export STELLAR_RPC_URL="${MAINNET_RPC_URL:-https://rpc.lightsail.network}"
    # Mainnet's Soroban inclusion fee runs above the CLI's 100-stroop default;
    # under it, transactions wait out their timeout instead of landing.
    export STELLAR_INCLUSION_FEE="${STELLAR_INCLUSION_FEE:-1000}"
    export STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
    HORIZON_URL="https://horizon.stellar.org"
    EXPERT="https://stellar.expert/explorer/public"
    ;;
  *) echo "NETWORK must be testnet or mainnet" >&2; exit 1 ;;
esac
unset STELLAR_NETWORK

DEPLOYMENTS="$ROOT/deployments/$NETWORK.json"
[ -f "$DEPLOYMENTS" ] || echo '{"contracts":{},"assets":{},"txs":[]}' > "$DEPLOYMENTS"

addr() { stellar keys address "$1"; }

get() { jq -r "$1 // empty" "$DEPLOYMENTS"; }

put() {
  local tmp; tmp="$(mktemp)"
  jq "$@" "$DEPLOYMENTS" > "$tmp" && mv "$tmp" "$DEPLOYMENTS"
}

record_tx() {
  local label="$1" hash="$2"
  put --arg l "$label" --arg h "$hash" --arg u "$EXPERT/tx/$hash" \
    '.txs += [{label: $l, hash: $h, url: $u}]'
  echo "  $label: $EXPERT/tx/$hash"
}

# Runs a stellar CLI command, records its transaction hash under a label,
# and prints the command's stdout (the contract return value, if any).
run_tx() {
  local label="$1"; shift
  local log out hash
  log="$(mktemp)"
  out="$("$@" 2>"$log")" || { cat "$log" >&2; rm -f "$log"; return 1; }
  hash="$(grep -oE 'Signing transaction: [0-9a-f]{64}' "$log" | tail -1 | grep -oE '[0-9a-f]{64}' || true)"
  rm -f "$log"
  [ -n "$hash" ] && record_tx "$label" "$hash" >&2
  printf '%s' "$out"
}

invoke() {
  local label="$1" id="$2" source="$3"; shift 3
  run_tx "$label" stellar contract invoke --id "$id" --source-account "$source" -- "$@"
}

view() {
  local id="$1"; shift
  stellar contract invoke --id "$id" --source-account "$ADMIN_IDENTITY" --send no -- "$@" 2>/dev/null
}

ensure_identity() {
  local name="$1"
  if ! stellar keys address "$name" >/dev/null 2>&1; then
    if [ "$NETWORK" = mainnet ]; then
      echo "Missing identity '$name'. Add your own key with: stellar keys add $name" >&2
      exit 1
    fi
    stellar keys generate "$name" --network testnet --fund >/dev/null 2>&1
  elif [ "$NETWORK" = testnet ]; then
    curl -s "https://friendbot.stellar.org?addr=$(addr "$name")" >/dev/null || true
  fi
}

asset_id() { stellar contract id asset --asset "$1"; }
