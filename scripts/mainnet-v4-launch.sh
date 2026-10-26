#!/usr/bin/env bash
# Launches the v0.4 platform on mainnet beside the original one: attested
# fund code, platform, shelf, managers, a 300 s timelock, and a showcase fund
# that trades through Soroswap. Resumable: every step checks
# deployments/mainnet-v4.json and skips what already exists. The original
# platform, NAV contract and funds are never touched.
#
#   RELEASE_TAG=v0.4.0 ALLOY_YES=1 ./scripts/mainnet-v4-launch.sh
#
# Extra managers to allowlist: EXTRA_MANAGERS="G... G..."
# A separate platform (for example a demo one): DEPLOY_NAME=mainnet-demo,
# with ADMIN_IDENTITY as its timelock proposer and executor, and
# SHOWCASE=0 to skip the showcase fund.
set -euo pipefail
export NETWORK=mainnet
export ADMIN_IDENTITY="${ADMIN_IDENTITY:-alloy-main-admin}"
export MANAGER_IDENTITY="${MANAGER_IDENTITY:-alloy-main-manager}"
export RELEASE_TAG="${RELEASE_TAG:-v0.4.0}"
. "$(dirname "$0")/lib.sh"

V3="$DEPLOYMENTS"
DEPLOYMENTS="$ROOT/deployments/${DEPLOY_NAME:-mainnet-v4}.json"
[ -f "$DEPLOYMENTS" ] || jq '{contracts: {nav: .contracts.nav, funds: {}}, assets: .assets, txs: []}' "$V3" > "$DEPLOYMENTS"

[ "${ALLOY_YES:-}" = 1 ] || { echo "Mainnet launch. Set ALLOY_YES=1 to proceed." >&2; exit 1; }

WASM_DIR="$ROOT/target/release-wasm/$RELEASE_TAG"
release_wasm() {
  local asset="$1_${RELEASE_TAG}.wasm"
  mkdir -p "$WASM_DIR"
  [ -f "$WASM_DIR/$asset" ] || gh release download "$RELEASE_TAG" -R "${REPO_SLUG:-0xDanomite/alloy-stellar}" -p "$asset" -D "$WASM_DIR" >&2
  gh attestation verify "$WASM_DIR/$asset" -R "${REPO_SLUG:-0xDanomite/alloy-stellar}" >/dev/null
  echo "$WASM_DIR/$asset"
}

admin="$(addr "$ADMIN_IDENTITY")"
manager="$(addr "$MANAGER_IDENTITY")"

V4="$ROOT/deployments/mainnet-v4.json"
if [ -z "$(get .fund_wasm)" ] && [ "$DEPLOYMENTS" != "$V4" ] && [ -f "$V4" ] && [ "$(jq -r .release "$V4")" = "$RELEASE_TAG" ]; then
  put --arg w "$(jq -r .fund_wasm "$V4")" --arg r "$RELEASE_TAG" '.fund_wasm = $w | .release = $r'
fi
if [ -z "$(get .fund_wasm)" ]; then
  fund_wasm="$(run_tx "upload fund wasm (mainnet build)" stellar contract upload \
    --wasm "$(release_wasm alloy-fund-mainnet)" --source-account "$ADMIN_IDENTITY")"
  put --arg w "$fund_wasm" --arg r "$RELEASE_TAG" '.fund_wasm = $w | .release = $r'
fi

if [ -z "$(get .contracts.platform)" ]; then
  platform="$(run_tx "deploy platform" stellar contract deploy \
    --wasm "$(release_wasm alloy-platform)" --source-account "$ADMIN_IDENTITY" \
    -- --admin "$admin" --fund_wasm "$(get .fund_wasm)")"
  put --arg p "$platform" --arg a "$admin" '.contracts.platform = $p | .admin = $a'
fi
platform="$(get .contracts.platform)"
echo "platform: $EXPERT/contract/$platform"

for code in $(jq -r '.assets | keys[]' "$DEPLOYMENTS"); do
  [ "$(get ".shelf[\"$code\"]")" = done ] && continue
  status="$(get ".assets[\"$code\"].status")"
  [ "$status" = permissioned ] && status=Permissioned || status=Open
  invoke "shelf $code $status" "$platform" "$ADMIN_IDENTITY" \
    set_shelf_asset --token "$(get ".assets[\"$code\"].contract")" --status "$status" >/dev/null
  put --arg c "$code" '.shelf[$c] = "done"'
done

for m in "$manager" ${EXTRA_MANAGERS:-}; do
  [ "$(get ".managers[\"$m\"]")" = done ] && continue
  invoke "allowlist manager ${m:0:6}" "$platform" "$ADMIN_IDENTITY" \
    set_manager --manager "$m" --allowed true >/dev/null
  put --arg m "$m" '.managers[$m] = "done"'
done

if [ -z "$(get .contracts.timelock)" ]; then
  timelock="$(run_tx "deploy timelock (300 s)" stellar contract deploy \
    --wasm "$(release_wasm alloy-timelock)" --source-account "$ADMIN_IDENTITY" \
    -- --proposers "[\"$admin\"]" --executors "[\"$admin\"]" --delay 300)"
  put --arg t "$timelock" '.contracts.timelock = $t'
fi
echo "timelock: $EXPERT/contract/$(get .contracts.timelock)"

[ "${SHOWCASE:-1}" = 1 ] || { echo "done. Hand the platform to the timelock with: node scripts/timelock-handover.mjs $DEPLOYMENTS $ADMIN_IDENTITY"; exit 0; }
symbol=aLQD
if [ -z "$(get ".contracts.funds[\"$symbol\"]")" ]; then
  components="$(jq -c '[
    {token: .assets.USDC.contract, initial_units: "4000000"},
    {token: .assets.USTRY.contract, initial_units: "3000000"},
    {token: .assets.XLM.contract, initial_units: "20000000"}]' "$DEPLOYMENTS")"
  fund="$(invoke "create fund $symbol" "$platform" "$MANAGER_IDENTITY" create_fund \
    --manager "$manager" --name "Alloy Liquid Dollar" --symbol "$symbol" \
    --components "$components" --compliance '"Open"' --salt "$(openssl rand -hex 32)" | tr -d '"')"
  put --arg s "$symbol" --arg f "$fund" '.contracts.funds[$s] = $f'
fi
fund="$(get ".contracts.funds[\"$symbol\"]")"
echo "fund $symbol: $EXPERT/contract/$fund"

setup() {
  local key="$1" label="$2"; shift 2
  [ "$(get ".setup[\"$key\"]")" = done ] && return
  invoke "$label" "$fund" "$MANAGER_IDENTITY" "$@" >/dev/null
  put --arg k "$key" '.setup[$k] = "done"'
}
setup metadata "$symbol profile" set_metadata --key description \
  --value "Dollars, US Treasury bills and Lumens: the most liquid assets on Stellar, rebalanced through Soroswap."
setup mandate "$symbol mandate Managed" set_mandate --mandate '"Managed"'
setup fee "$symbol fee 0.5%/yr" init_fee --rate_bps 50
setup open "$symbol open for issue" open_for_issue

echo "done. Hand the platform to the timelock with: node scripts/timelock-handover.mjs"
