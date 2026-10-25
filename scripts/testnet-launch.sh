#!/usr/bin/env bash
# Testnet mirror of the mainnet launch: the same three funds, built from
# t-prefixed stand-ins issued by throwaway testnet accounts, with SDEX
# liquidity posted at live mainnet prices so pricing and the buy-the-basket
# flow work end to end. Stand-ins carry the real assets' flags; none of them
# is, or claims to be, the real asset.
set -euo pipefail
export NETWORK=testnet
S="$(dirname "$0")/alloy.sh"
. "$(dirname "$0")/lib.sh"

OPEN_ISSUER=alloy-t-issuer
BENJI_ISSUER=alloy-t-benji-issuer
MAKER=alloy-t-maker
MAINNET_HORIZON=https://horizon.stellar.org
MAINNET_USDC=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# USD price of one unit of a mainnet asset, read from mainnet SDEX.
usd_price() {
  local code="$1" issuer="$2" type
  [ "$code" = USDC ] && { echo 1; return; }
  [ ${#code} -le 4 ] && type=credit_alphanum4 || type=credit_alphanum12
  curl -s "$MAINNET_HORIZON/paths/strict-send?source_asset_type=$type&source_asset_code=$code&source_asset_issuer=$issuer&source_amount=1&destination_assets=USDC:$MAINNET_USDC" \
    | jq -r '[._embedded.records[].destination_amount | tonumber] | max'
}

xlm_usd="$(curl -s "$MAINNET_HORIZON/paths/strict-send?source_asset_type=native&source_amount=100&destination_assets=USDC:$MAINNET_USDC" \
  | jq -r '[._embedded.records[].destination_amount | tonumber] | max / 100')"
echo "XLM = $xlm_usd USD (mainnet SDEX)"

# Posts a two-sided book against XLM at the given USD price, 0.5% spread.
make_market() {
  local code="$1" usd="$2" asset maker per_xlm ask bid
  asset="$(get ".assets[\"$code\"].asset")"
  maker="$(addr "$MAKER")"
  per_xlm="$(echo "scale=7; $usd / $xlm_usd" | bc)"
  ask="$(echo "scale=7; $per_xlm * 1.0025" | bc)"
  bid="$(echo "scale=7; 1 / ($per_xlm * 0.9975)" | bc)"
  run_tx "maker trustline $code" stellar tx new change-trust --source-account "$MAKER" --line "$asset" >/dev/null || true
  run_tx "maker inventory $code" stellar tx new payment --source-account "$(get ".assets[\"$code\"].issuer_identity")" \
    --destination "$maker" --asset "$asset" --amount 10000000000000 >/dev/null
  run_tx "ask $code" stellar tx new manage-sell-offer --source-account "$MAKER" \
    --selling "$asset" --buying native --amount 5000000000000 \
    --price "$(echo "$ask * 10000000 / 1" | bc):10000000" >/dev/null
  run_tx "bid $code" stellar tx new manage-sell-offer --source-account "$MAKER" \
    --selling native --buying "$asset" --amount 10000000000 \
    --price "$(echo "$bid * 10000000 / 1" | bc):10000000" >/dev/null
  echo "$code: $per_xlm XLM per unit (USD $usd)"
}

ensure_identity "$MAKER"
step() { [ -n "$(get "$1")" ]; }

# Testnet storage rent runs far above mainnet when testnet's state is over
# its target size; one fund deploy can cost more than a friendbot grant.
# Tops an identity up by merging freshly friendbot-funded accounts into it.
xlm_of() {
  curl -s "$HORIZON_URL/accounts/$(addr "$1")" \
    | jq -r '[.balances[]? | select(.asset_type == "native")][0].balance // "0" | tonumber | floor'
}
top_up() {
  local id="$1" want="$2" n=0
  while [ "$(xlm_of "$id")" -lt "$want" ]; do
    local donor="alloy-t-donor-$RANDOM"
    stellar keys generate "$donor" >/dev/null 2>&1
    curl -s "https://friendbot.stellar.org?addr=$(addr "$donor")" >/dev/null
    stellar tx new account-merge --source-account "$donor" --account "$(addr "$id")" >/dev/null 2>&1
    stellar keys rm "$donor" >/dev/null 2>&1 || true
    n=$((n + 1))
    [ "$n" -lt 12 ] || { echo "top-up stalled for $id" >&2; exit 1; }
  done
  echo "$id: $(xlm_of "$id") XLM"
}

step '.assets.tUSDC' || "$S" issue-asset tUSDC "$OPEN_ISSUER" open
step '.assets.tUSDY' || "$S" issue-asset tUSDY "$OPEN_ISSUER" open
step '.assets.tUSTRY' || "$S" issue-asset tUSTRY "$OPEN_ISSUER" open
step '.assets.tCETES' || "$S" issue-asset tCETES "$OPEN_ISSUER" open
step '.assets.tBENJI' || "$S" issue-asset tBENJI "$BENJI_ISSUER" permissioned

if ! step '.market_done'; then
  make_market tUSDC 1
  make_market tUSDY "$(usd_price USDY GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6)"
  make_market tUSTRY "$(usd_price USTRY GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC)"
  make_market tCETES "$(usd_price CETES GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC)"
  put '.market_done = true'
fi

step '.shelf_v2' || { "$S" shelf; put '.shelf_v2 = true'; }

top_up "$MANAGER_IDENTITY" 60000
top_up "$INVESTOR_IDENTITY" 30000

if ! step '.contracts.funds.aTRSY'; then
  "$S" create-fund "Alloy Stellar Treasury" aTRSY Open \
    tUSDC=2500000 tUSDY=2000000 tUSTRY=2000000 tCETES=30000000 XLM=10000000
fi
if ! step '.contracts.funds.aBENJI'; then
  "$S" create-fund "Alloy Treasury + BENJI" aBENJI Allowlist \
    tUSDC=5000000 tUSTRY=2500000 tBENJI=5000000
fi
if ! step '.contracts.funds.aRAIL'; then
  "$S" create-fund "Issuer Rails Demo" aRAIL Allowlist tUSDC=2500000 DEMOMMF=10000000
fi

investor="$(addr "$INVESTOR_IDENTITY")"
if ! step '.seeded.aTRSY'; then
  "$S" buy tUSDC 15000000 "$INVESTOR_IDENTITY"
  "$S" buy tUSDY 4000000 "$INVESTOR_IDENTITY"
  "$S" buy tUSTRY 4000000 "$INVESTOR_IDENTITY"
  "$S" buy tCETES 60000000 "$INVESTOR_IDENTITY"
  "$S" issue aTRSY 20000000
  put '.seeded.aTRSY = true'
fi
if ! step '.seeded.aRAIL'; then
  "$S" allowlist aRAIL "$investor"
  "$S" authorize-fund aRAIL DEMOMMF
  "$S" issue aRAIL 20000000
  "$S" clawback-drill aRAIL DEMOMMF 5000000
  "$S" redeem aRAIL 10000000
  put '.seeded.aRAIL = true'
fi

"$S" status aTRSY
"$S" status aRAIL
echo "aBENJI waits on issuer authorization: $(get .contracts.funds.aBENJI)"
