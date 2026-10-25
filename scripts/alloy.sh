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

# Path to a contract's wasm. With RELEASE_TAG set, the attested binary from
# that GitHub release (SEP-0055 verified build); otherwise a local build.
# Mainnet only ever deploys release binaries.
REPO_SLUG="${REPO_SLUG:-0xDanomite/alloy-stellar}"
wasm_path() {
  local package="$1"
  if [ -z "${RELEASE_TAG:-}" ]; then
    [ "$NETWORK" = mainnet ] && { echo "mainnet deploys need RELEASE_TAG (a verified build)" >&2; exit 1; }
    echo "$WASM_DIR/${package//-/_}.wasm"
    return
  fi
  local dir="$ROOT/target/release-wasm/$RELEASE_TAG"
  mkdir -p "$dir"
  gh release download "$RELEASE_TAG" -R "$REPO_SLUG" -p "${package}_v*.wasm" -D "$dir" --clobber >&2
  gh attestation verify "$(ls "$dir"/"${package}"_v*.wasm | head -1)" -R "$REPO_SLUG" >&2
  ls "$dir"/"${package}"_v*.wasm | head -1
}

cmd_deploy() {
  ensure_identity "$ADMIN_IDENTITY"
  ensure_identity "$MANAGER_IDENTITY"
  [ -n "${RELEASE_TAG:-}" ] || cmd_build >/dev/null
  local admin fund_wasm platform
  admin="$(addr "$ADMIN_IDENTITY")"
  fund_wasm="$(run_tx "upload fund wasm" stellar contract upload \
    --wasm "$(wasm_path alloy-fund)" --source-account "$ADMIN_IDENTITY")"
  platform="$(run_tx "deploy platform" stellar contract deploy \
    --wasm "$(wasm_path alloy-platform)" --source-account "$ADMIN_IDENTITY" \
    -- --admin "$admin" --fund_wasm "$fund_wasm")"
  put --arg p "$platform" --arg w "$fund_wasm" --arg a "$admin" --arg r "${RELEASE_TAG:-local}" \
    '.contracts.platform = $p | .fund_wasm = $w | .admin = $a | .release = $r'
  invoke "allowlist manager" "$platform" "$ADMIN_IDENTITY" \
    set_manager --manager "$(addr "$MANAGER_IDENTITY")" --allowed true >/dev/null
  echo "platform: $EXPERT/contract/$platform"
}

cmd_set_fund_wasm() {
  [ -n "${RELEASE_TAG:-}" ] || cmd_build >/dev/null
  local platform fund_wasm
  platform="$(get .contracts.platform)"
  fund_wasm="$(run_tx "upload fund wasm" stellar contract upload \
    --wasm "$(wasm_path alloy-fund)" --source-account "$ADMIN_IDENTITY")"
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

# Pinned mainnet issuers, read from Horizon and each issuer's stellar.toml on
# 2026-10-25. Lookalike issuers are common; never resolve these by code.
MAINNET_ASSETS=(
  "XLM - open"
  "USDC GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN open"
  "USDY GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6 open"
  "USTRY GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC open"
  "CETES GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC open"
  "BENJI GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 permissioned"
)

cmd_mainnet_assets() {
  [ "$NETWORK" = mainnet ] || { echo "mainnet only" >&2; exit 1; }
  local entry
  for entry in "${MAINNET_ASSETS[@]}"; do
    # shellcheck disable=SC2086
    cmd_add_asset $entry
  done
}

USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# buy CODE AMOUNT_STROOPS [IDENTITY] : buy an exact amount with XLM on the SDEX,
# routing only direct or through Circle USDC so no unvetted token is touched.
cmd_buy() {
  local code="$1" amount="$2" identity="${3:-$MANAGER_IDENTITY}" asset account quote send_max path
  asset="$(get ".assets[\"$code\"].asset")"
  account="$(addr "$identity")"
  if ! curl -s "$HORIZON_URL/accounts/$account" | jq -e --arg a "$asset" \
      '.balances[] | select((.asset_code + ":" + .asset_issuer) == $a)' >/dev/null; then
    run_tx "trustline $code" stellar tx new change-trust --source-account "$identity" --line "$asset" >/dev/null
  fi
  quote="$(curl -s "$HORIZON_URL/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum$([ ${#code} -le 4 ] && echo 4 || echo 12)&destination_asset_code=$code&destination_asset_issuer=${asset#*:}&destination_amount=$(echo "scale=7; $amount / 10000000" | bc)" \
    | jq -c --arg usdc "$USDC_ISSUER" '._embedded.records
        | map(select(all(.path[]; .asset_type == "native" or (.asset_code == "USDC" and .asset_issuer == $usdc))))
        | if length == 0 then null else min_by(.source_amount | tonumber) end')"
  [ "$quote" != null ] || { echo "no path to $code" >&2; exit 1; }
  send_max="$(jq -r '.source_amount | tonumber * 1.02 * 10000000 | floor' <<<"$quote")"
  path="$(jq -r '[.path[] | if .asset_type == "native" then "native" else .asset_code + ":" + .asset_issuer end] | join(",")' <<<"$quote")"
  echo "buying $code: up to $(jq -r .source_amount <<<"$quote") XLM (+2%) via [${path:-direct}]"
  run_tx "buy $code" stellar tx new path-payment-strict-receive --source-account "$identity" \
    --send-asset native --send-max "$send_max" --destination "$account" \
    --dest-asset "$asset" --dest-amount "$amount" ${path:+--path "$path"} >/dev/null
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

# Oracles (mainnet, verified by simulation on 2026-10-25). RedStone's SEP-40
# adapter quotes USD at 8 decimals; Reflector quotes in USDC at 14. BENJI is
# on neither SEP-40 contract, only on RedStone's BENJI_ETHEREUM_FUNDAMENTAL
# single-feed contract.
REDSTONE_ORACLE="${REDSTONE_ORACLE:-CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF}"
REFLECTOR_ORACLE="${REFLECTOR_ORACLE:-CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M}"
REDSTONE_BENJI_FEED=CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5
# RedStone heartbeats are 12-24h; Reflector resolves every 5 minutes.
REDSTONE_MAX_AGE=$((26 * 3600))
REFLECTOR_MAX_AGE=$((15 * 60))

# nav-deploy : the read-only NAV contract; USDC's route converts USDC quotes
cmd_nav_deploy() {
  ensure_identity "$ADMIN_IDENTITY"
  [ -n "${RELEASE_TAG:-}" ] || cmd_build >/dev/null
  local usdc nav
  usdc="${USDC_CONTRACT:-$(get '.assets["USDC"].contract')}"
  [ -n "$usdc" ] || { echo "no USDC asset; run add-asset USDC first or set USDC_CONTRACT" >&2; exit 1; }
  nav="$(run_tx "deploy nav" stellar contract deploy \
    --wasm "$(wasm_path alloy-nav)" --source-account "$ADMIN_IDENTITY" \
    -- --admin "$(addr "$ADMIN_IDENTITY")" --usdc "$usdc")"
  put --arg n "$nav" '.contracts.nav = $n'
  echo "nav: $EXPERT/contract/$nav"
}

# Route JSON for a token: redstone | reflector | redstone-feed:CONTRACT
route_json() {
  local kind="$1" token="$2"
  case "$kind" in
    redstone) jq -nc --arg o "$REDSTONE_ORACLE" --arg t "$token" --argjson a "$REDSTONE_MAX_AGE" \
      '{oracle: $o, feed: {Sep40: {Stellar: $t}}, quote: "Usd", max_age_secs: $a, source: "redstone"}' ;;
    reflector) jq -nc --arg o "$REFLECTOR_ORACLE" --arg t "$token" --argjson a "$REFLECTOR_MAX_AGE" \
      '{oracle: $o, feed: {Sep40: {Stellar: $t}}, quote: "Usdc", max_age_secs: $a, source: "reflector"}' ;;
    redstone-feed:*) jq -nc --arg o "${kind#redstone-feed:}" --argjson a "$REDSTONE_MAX_AGE" \
      '{oracle: $o, feed: "RedStoneFeed", quote: "Usd", max_age_secs: $a, source: "redstone"}' ;;
    *) echo "route must be redstone, reflector or redstone-feed:CONTRACT" >&2; exit 1 ;;
  esac
}

# nav-route CODE PRIMARY [SECONDARY]
cmd_nav_route() {
  local code="$1" primary="$2" secondary="${3:-}" nav token
  nav="$(get .contracts.nav)"
  token="$(get ".assets[\"$code\"].contract")"
  [ -n "$nav" ] && [ -n "$token" ] || { echo "need .contracts.nav and asset $code" >&2; exit 1; }
  invoke "nav route $code" "$nav" "$ADMIN_IDENTITY" set_route --token "$token" \
    --primary "$(route_json "$primary" "$token")" \
    ${secondary:+--secondary "$(route_json "$secondary" "$token")"} >/dev/null
  echo "$code: $primary${secondary:+ then $secondary}"
}

cmd_mainnet_nav_routes() {
  [ "$NETWORK" = mainnet ] || { echo "mainnet only" >&2; exit 1; }
  cmd_nav_route XLM reflector redstone
  cmd_nav_route USDC reflector redstone
  cmd_nav_route USDY redstone
  cmd_nav_route USTRY redstone reflector
  cmd_nav_route CETES redstone reflector
  cmd_nav_route BENJI "redstone-feed:$REDSTONE_BENJI_FEED"
}

# nav SYMBOL : oracle NAV per share, or each leg's price when one is unpriced
cmd_nav() {
  local nav fund code token
  nav="$(get .contracts.nav)"
  fund="$(fund_id "$1")"
  if view "$nav" nav --fund "$fund"; then echo; return; fi
  echo "no full NAV for $1; per leg:"
  for token in $(view "$fund" components | jq -r '.[].token'); do
    code="$(jq -r --arg t "$token" '.assets | to_entries[] | select(.value.contract == $t) | .key' "$DEPLOYMENTS")"
    echo "  ${code:-$token}: $(view "$nav" price --token "$token" || echo unpriced)"
  done
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
  mainnet-assets) cmd_mainnet_assets ;;
  buy) cmd_buy "$@" ;;
  shelf) cmd_shelf ;;
  create-fund) cmd_create_fund "$@" ;;
  authorize-fund) cmd_authorize_fund "$@" ;;
  fund-investor) cmd_fund_investor "$@" ;;
  allowlist) cmd_allowlist "$@" ;;
  issue) cmd_issue "$@" ;;
  redeem) cmd_redeem "$@" ;;
  clawback-drill) cmd_clawback_drill "$@" ;;
  status) cmd_status "$@" ;;
  nav-deploy) cmd_nav_deploy ;;
  nav-route) cmd_nav_route "$@" ;;
  mainnet-nav-routes) cmd_mainnet_nav_routes ;;
  nav) cmd_nav "$@" ;;
  *) sed -n 2,8p "$0"; echo "commands: build deploy set-fund-wasm issue-asset add-asset mainnet-assets buy shelf create-fund authorize-fund fund-investor allowlist issue redeem clawback-drill status nav-deploy nav-route mainnet-nav-routes nav"; exit 1 ;;
esac
