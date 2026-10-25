#!/usr/bin/env bash
# Mainnet launch: platform, shelf, and three funds.
#
#   aTRSY  Alloy Stellar Treasury  USDC + USDY + USTRY + CETES + XLM   open, seeded
#   aBENJI Alloy Treasury + BENJI  USDC + USTRY + BENJI                allowlist; waits on Franklin
#   aRAIL  Issuer Rails Demo       USDC + DEMOMMF (BENJI's flags)      allowlist; full drill
#
# Needs identities you created yourself (`stellar keys generate <name>` then
# fund them from your wallet): alloy-admin (~40 XLM), alloy-manager (~40 XLM),
# alloy-demo-issuer (~10 XLM). Resumable: steps already in
# deployments/mainnet.json are skipped.
set -euo pipefail
export NETWORK=mainnet
export INVESTOR_IDENTITY="${INVESTOR_IDENTITY:-alloy-manager}"
S="$(dirname "$0")/alloy.sh"
. "$(dirname "$0")/lib.sh"

for id in "$ADMIN_IDENTITY" "$MANAGER_IDENTITY" "$DEMO_ISSUER_IDENTITY"; do
  a="$(addr "$id")" || { echo "missing identity $id" >&2; exit 1; }
  xlm="$(curl -s "$HORIZON_URL/accounts/$a" | jq -r '[.balances[] | select(.asset_type == "native")][0].balance // "unfunded"')"
  echo "$id $a  XLM: $xlm"
done
read -r -p "Spend real XLM on mainnet with these accounts? [yes/no] " answer
[ "$answer" = yes ] || exit 1

step() { [ -n "$(get "$1")" ]; }

step .contracts.platform || "$S" deploy
step '.assets.USDC' || "$S" mainnet-assets
step '.assets.DEMOMMF' || "$S" issue-asset DEMOMMF "$DEMO_ISSUER_IDENTITY" permissioned
step '.shelf_done' || { "$S" shelf; put '.shelf_done = true'; }

if ! step '.contracts.funds.aTRSY'; then
  "$S" create-fund "Alloy Stellar Treasury" aTRSY Open \
    USDC=2500000 USDY=2000000 USTRY=2000000 CETES=30000000 XLM=10000000
fi
if ! step '.contracts.funds.aBENJI'; then
  "$S" create-fund "Alloy Treasury + BENJI" aBENJI Allowlist \
    USDC=5000000 USTRY=2500000 BENJI=5000000
fi
if ! step '.contracts.funds.aRAIL'; then
  "$S" create-fund "Issuer Rails Demo" aRAIL Allowlist USDC=2500000 DEMOMMF=10000000
fi

if ! step '.seeded.aTRSY'; then
  "$S" buy USDC 15000000
  "$S" buy USDY 4000000
  "$S" buy USTRY 4000000
  "$S" buy CETES 60000000
  "$S" issue aTRSY 20000000
  put '.seeded.aTRSY = true'
fi

if ! step '.seeded.aRAIL'; then
  "$S" fund-investor DEMOMMF 50000000
  "$S" allowlist aRAIL "$(addr "$INVESTOR_IDENTITY")"
  "$S" authorize-fund aRAIL DEMOMMF
  "$S" issue aRAIL 20000000
  "$S" clawback-drill aRAIL DEMOMMF 5000000
  "$S" redeem aRAIL 10000000
  put '.seeded.aRAIL = true'
fi

"$S" status aTRSY
"$S" status aRAIL
echo "aBENJI waits for Franklin: set_authorized on $(get .contracts.funds.aBENJI)"
