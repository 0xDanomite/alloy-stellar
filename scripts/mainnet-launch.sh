#!/usr/bin/env bash
# Mainnet launch: platform, shelf, and three funds.
#
#   aTRSY  Alloy Stellar Treasury  USDC + USDY + USTRY + CETES + XLM   open, seeded
#   aBENJI Alloy Treasury + BENJI  USDC + USTRY + BENJI                allowlist; waits on Franklin
#   aRAIL  Issuer Rails Demo       USDC + DEMOMMF (BENJI's flags)      allowlist; full drill
#
# Identities live in the local stellar keystore (alloy-main-admin,
# alloy-main-manager, alloy-main-issuer by default). Fund only the admin with
# ~95 XLM; the script opens the manager (40 XLM) and issuer (10 XLM) from it.
# ALLOY_YES=1 skips the confirmation prompt. Contracts come from the attested GitHub
# release RELEASE_TAG (default v0.2.0), never a local build. Resumable: steps already in
# deployments/mainnet.json are skipped.
set -euo pipefail
export NETWORK=mainnet
export ADMIN_IDENTITY="${ADMIN_IDENTITY:-alloy-main-admin}"
export MANAGER_IDENTITY="${MANAGER_IDENTITY:-alloy-main-manager}"
export DEMO_ISSUER_IDENTITY="${DEMO_ISSUER_IDENTITY:-alloy-main-issuer}"
export RELEASE_TAG="${RELEASE_TAG:-v0.2.0}"
export INVESTOR_IDENTITY="${INVESTOR_IDENTITY:-$MANAGER_IDENTITY}"
S="$(dirname "$0")/alloy.sh"
. "$(dirname "$0")/lib.sh"

xlm_of() {
  curl -s "$HORIZON_URL/accounts/$(addr "$1")" \
    | jq -r '[.balances[]? | select(.asset_type == "native")][0].balance // "0"'
}

for id in "$ADMIN_IDENTITY" "$MANAGER_IDENTITY" "$DEMO_ISSUER_IDENTITY"; do
  addr "$id" >/dev/null || { echo "missing identity $id" >&2; exit 1; }
  echo "$id $(addr "$id")  XLM: $(xlm_of "$id")"
done
if [ "${ALLOY_YES:-}" != 1 ]; then
  read -r -p "Spend real XLM on mainnet with these accounts? [yes/no] " answer
  [ "$answer" = yes ] || exit 1
fi

open_account() {
  local id="$1" stroops="$2"
  if [ "$(xlm_of "$id")" = 0 ]; then
    run_tx "open $id" stellar tx new create-account --source-account "$ADMIN_IDENTITY" \
      --destination "$(addr "$id")" --starting-balance "$stroops" >/dev/null
  fi
}
open_account "$MANAGER_IDENTITY" 400000000
open_account "$DEMO_ISSUER_IDENTITY" 100000000

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

step '.contracts.nav' || "$S" nav-deploy
step '.nav_routes_done' || { "$S" mainnet-nav-routes; put '.nav_routes_done = true'; }

"$S" status aTRSY
"$S" nav aTRSY
"$S" status aRAIL
echo "aBENJI waits for Franklin: set_authorized on $(get .contracts.funds.aBENJI)"
