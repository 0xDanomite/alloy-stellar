#!/usr/bin/env bash
# Alloy on Stellar, one entry point per journey step.
#
#   NETWORK=testnet scripts/alloy.sh <command> [args]
#
# Every transaction hash lands in deployments/$NETWORK.json with its Stellar
# Expert link. Mainnet uses identities you added yourself (`stellar keys add`);
# testnet generates and funds throwaway ones.
. "$(dirname "$0")/lib.sh"

WASM_DIR="$ROOT/target/wasm32v1-none/release"

cmd_build() {
  (cd "$ROOT" && stellar contract build >/dev/null)
  ls -la "$WASM_DIR"/alloy_*.wasm
}

cmd_deploy() {
  ensure_identity "$ADMIN_IDENTITY"
  ensure_identity "$MANAGER_IDENTITY"
  cmd_build >/dev/null
  local admin fund_wasm platform
  admin="$(addr "$ADMIN_IDENTITY")"
  fund_wasm="$(run_tx "upload fund wasm" stellar contract upload \
    --wasm "$WASM_DIR/alloy_fund.wasm" --source-account "$ADMIN_IDENTITY")"
  platform="$(run_tx "deploy platform" stellar contract deploy \
    --wasm "$WASM_DIR/alloy_platform.wasm" --source-account "$ADMIN_IDENTITY" \
    -- --admin "$admin" --fund_wasm "$fund_wasm")"
  put --arg p "$platform" --arg w "$fund_wasm" --arg a "$admin" \
    '.contracts.platform = $p | .fund_wasm = $w | .admin = $a'
  invoke "allowlist manager" "$platform" "$ADMIN_IDENTITY" \
    set_manager --manager "$(addr "$MANAGER_IDENTITY")" --allowed true >/dev/null
  echo "platform: $EXPERT/contract/$platform"
}

cmd_set_fund_wasm() {
  cmd_build >/dev/null
  local platform fund_wasm
  platform="$(get .contracts.platform)"
  fund_wasm="$(run_tx "upload fund wasm" stellar contract upload \
    --wasm "$WASM_DIR/alloy_fund.wasm" --source-account "$ADMIN_IDENTITY")"
  invoke "set fund wasm" "$platform" "$ADMIN_IDENTITY" set_fund_wasm --wasm_hash "$fund_wasm" >/dev/null
  put --arg w "$fund_wasm" '.fund_wasm = $w'
  echo "fund wasm: $fund_wasm"
}

# issue-asset CODE IDENTITY [permissioned]
# Testnet stand-ins, and the mainnet demo asset with BENJI's flags.
cmd_issue_asset() {
  local code="$1" identity="$2" mode="${3:-open}"
  ensure_identity "$identity"
  local issuer flags=(--set-revocable --set-clawback-enabled)
  issuer="$(addr "$identity")"
  [ "$mode" = permissioned ] && flags+=(--set-required)
  run_tx "issuer flags $code" stellar tx new set-options \
    --source-account "$identity" "${flags[@]}" >/dev/null
  run_tx "deploy SAC $code" stellar contract asset deploy \
    --asset "$code:$issuer" --source-account "$identity" >/dev/null || true
  local id; id="$(asset_id "$code:$issuer")"
  put --arg c "$code" --arg i "$issuer" --arg id "$id" --arg m "$mode" --arg who "$identity" \
    '.assets[$c] = {asset: ($c + ":" + $i), contract: $id, status: $m, issuer_identity: $who}'
  echo "$code: $EXPERT/asset/$code-$issuer  (contract $id)"
}

# add-asset CODE ISSUER open|permissioned : register an existing asset (mainnet RWAs)
cmd_add_asset() {
  local code="$1" issuer="$2" mode="$3" asset id
  if [ "$code" = XLM ]; then asset=native; else asset="$code:$issuer"; fi
  id="$(asset_id "$asset")"
  put --arg c "$code" --arg a "$asset" --arg id "$id" --arg m "$mode" \
    '.assets[$c] = {asset: $a, contract: $id, status: $m}'
  echo "$code: contract $id"
}

cmd_shelf() {
  local platform; platform="$(get .contracts.platform)"
  for code in $(jq -r '.assets | keys[]' "$DEPLOYMENTS"); do
    local id status
    id="$(get ".assets[\"$code\"].contract")"
    status="$(get ".assets[\"$code\"].status")"
    [ "$status" = permissioned ] && status=Permissioned || status=Open
    invoke "shelf $code $status" "$platform" "$ADMIN_IDENTITY" \
      set_shelf_asset --token "$id" --status "$status" >/dev/null
  done
  view "$platform" shelf
}

# create-fund NAME SYMBOL Open|Allowlist CODE=UNITS [CODE=UNITS...]
cmd_create_fund() {
  local name="$1" symbol="$2" compliance="$3"; shift 3
  local platform components="[]" pair code units id fund salt
  platform="$(get .contracts.platform)"
  for pair in "$@"; do
    code="${pair%%=*}"; units="${pair#*=}"
    id="$(get ".assets[\"$code\"].contract")"
    [ -n "$id" ] || { echo "unknown asset $code" >&2; exit 1; }
    components="$(jq -c --arg t "$id" --arg u "$units" '. + [{token: $t, initial_units: $u}]' <<<"$components")"
  done
  salt="$(openssl rand -hex 32)"
  fund="$(invoke "create fund $symbol" "$platform" "$MANAGER_IDENTITY" create_fund \
    --manager "$(addr "$MANAGER_IDENTITY")" --name "$name" --symbol "$symbol" \
    --components "$components" --compliance "\"$compliance\"" --salt "$salt" | tr -d '"')"
  put --arg s "$symbol" --arg f "$fund" '.contracts.funds[$s] = $f'
  echo "fund $symbol: $EXPERT/contract/$fund"
}

fund_id() { get ".contracts.funds[\"$1\"]"; }

# authorize-fund SYMBOL CODE : the issuer lets the fund contract hold its asset
cmd_authorize_fund() {
  local fund asset_contract issuer_identity
  fund="$(fund_id "$1")"
  asset_contract="$(get ".assets[\"$2\"].contract")"
  issuer_identity="$(get ".assets[\"$2\"].issuer_identity")"
  invoke "issuer authorizes fund for $2" "$asset_contract" "$issuer_identity" \
    set_authorized --id "$fund" --authorize true >/dev/null
  echo "authorized $1 to hold $2"
}

# fund-investor CODE AMOUNT_STROOPS : testnet/demo issuer pays the investor
cmd_fund_investor() {
  local code="$1" amount="$2" asset issuer_identity investor
  ensure_identity "$INVESTOR_IDENTITY"
  investor="$(addr "$INVESTOR_IDENTITY")"
  asset="$(get ".assets[\"$code\"].asset")"
  issuer_identity="$(get ".assets[\"$code\"].issuer_identity")"
  run_tx "trustline $code" stellar tx new change-trust \
    --source-account "$INVESTOR_IDENTITY" --line "$asset" >/dev/null
  if [ "$(get ".assets[\"$code\"].status")" = permissioned ]; then
    run_tx "issuer authorizes investor for $code" stellar tx new set-trustline-flags \
      --source-account "$issuer_identity" --trustor "$investor" --asset "$asset" --set-authorize >/dev/null
  fi
  run_tx "pay investor $code" stellar tx new payment --source-account "$issuer_identity" \
    --destination "$investor" --asset "$asset" --amount "$amount" >/dev/null
}

# allowlist SYMBOL ADDRESS
cmd_allowlist() {
  invoke "allowlist investor on $1" "$(fund_id "$1")" "$MANAGER_IDENTITY" \
    set_investor --investor "$2" --allowed true >/dev/null
}

# issue SYMBOL SHARES_STROOPS
cmd_issue() {
  local investor; investor="$(addr "$INVESTOR_IDENTITY")"
  echo "quote: $(view "$(fund_id "$1")" quote_issue --shares "$2")"
  invoke "issue $1" "$(fund_id "$1")" "$INVESTOR_IDENTITY" issue \
    --investor "$investor" --to "$investor" --shares "$2"
  echo
}

# redeem SYMBOL SHARES_STROOPS [SKIP_CODE...]
cmd_redeem() {
  local symbol="$1" shares="$2" investor skip="[]" code; shift 2
  investor="$(addr "$INVESTOR_IDENTITY")"
  for code in "$@"; do
    skip="$(jq -c --arg t "$(get ".assets[\"$code\"].contract")" '. + [$t]' <<<"$skip")"
  done
  invoke "redeem $symbol" "$(fund_id "$symbol")" "$INVESTOR_IDENTITY" redeem \
    --from "$investor" --to "$investor" --shares "$shares" --skip "$skip"
  echo
}

# clawback-drill SYMBOL CODE AMOUNT_STROOPS : issuer claws back from the fund
cmd_clawback_drill() {
  local fund asset_contract issuer_identity
  fund="$(fund_id "$1")"
  asset_contract="$(get ".assets[\"$2\"].contract")"
  issuer_identity="$(get ".assets[\"$2\"].issuer_identity")"
  echo "units per share before: $(view "$fund" units_per_share)"
  invoke "clawback drill $2 from $1" "$asset_contract" "$issuer_identity" \
    clawback --from "$fund" --amount "$3" >/dev/null
  echo "units per share after:  $(view "$fund" units_per_share)"
}

cmd_status() {
  local fund; fund="$(fund_id "$1")"
  echo "fund $1 $EXPERT/contract/$fund"
  echo "  supply:          $(view "$fund" total_supply)"
  echo "  components:      $(view "$fund" components)"
  echo "  holdings:        $(view "$fund" holdings)"
  echo "  units per share: $(view "$fund" units_per_share)"
}

command="${1:-}"; shift || true
case "$command" in
  build) cmd_build ;;
  deploy) cmd_deploy ;;
  set-fund-wasm) cmd_set_fund_wasm ;;
  issue-asset) cmd_issue_asset "$@" ;;
  add-asset) cmd_add_asset "$@" ;;
  shelf) cmd_shelf ;;
  create-fund) cmd_create_fund "$@" ;;
  authorize-fund) cmd_authorize_fund "$@" ;;
  fund-investor) cmd_fund_investor "$@" ;;
  allowlist) cmd_allowlist "$@" ;;
  issue) cmd_issue "$@" ;;
  redeem) cmd_redeem "$@" ;;
  clawback-drill) cmd_clawback_drill "$@" ;;
  status) cmd_status "$@" ;;
  *) sed -n 2,8p "$0"; echo "commands: build deploy set-fund-wasm issue-asset add-asset shelf create-fund authorize-fund fund-investor allowlist issue redeem clawback-drill status"; exit 1 ;;
esac
