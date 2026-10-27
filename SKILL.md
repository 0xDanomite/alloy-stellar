---
name: alloy-stellar
description: Use when investing in, redeeming, creating, rebalancing, or pricing an Alloy multi-asset fund on Stellar mainnet (Soroban fund, platform and NAV contracts).
---

# Alloy on Stellar

Alloy funds are SEP-41 tokens on Stellar whose shares hold a basket of real
Stellar assets: tokenized treasuries (USDY, USTRY, CETES), stablecoins
(USDC), XLM, and money-market funds (BENJI). A manager defines the basket
once; investors deposit it in kind, hold one token, and can redeem it for
the underlying assets at any time. Nobody, the manager included, can stop
a redemption.

It matters because Stellar carries each tokenized asset in its own wrapper.
Alloy is the layer above: one share of a managed portfolio, built for
issuer-permissioned assets, safe through clawbacks and freezes.

Live app: https://alloy-stellar.vercel.app (create a fund at `/create`).

## Mainnet contracts

From [deployments/mainnet.json](deployments/mainnet.json):

| Contract | ID |
| --- | --- |
| Platform | `CDV2FJ4J2IIFSUREC5VAHINVCSVZGOMIMXJHA32XD7H2CMY6DNXD6KDM` |
| NAV | `CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC` |
| aTRSY fund | `CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB` |
| aBENJI fund | `CCIQFFLE5X3T3SWWOET2N2LIPQLEUDTGLOGCDCBPDOM67ARH6A26MKG5` |
| aRAIL fund | `CCBONNERPF2UQGMRTOJELOSA574VDY6XFRNKLLVBZNLLEULZ65UYPWJJ` |
| aREBAL fund | `CAZ7FRP7M5RMLGGOPQZNZMIEN7ACNLVBG7AOVEBGBCBYH6JVUCLTDCTD` |

Asset contracts (SACs):

| Asset | Contract | Shelf |
| --- | --- | --- |
| XLM | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` | open |
| USDC | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | open |
| USDY | `CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP` | open |
| USTRY | `CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR` | open |
| CETES | `CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV` | open |
| BENJI | `CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A` | permissioned |
| DEMOMMF | `CCDKWOUML7ZBLXBWCLLX2BAWW5OCSU3BYCASK7KHSGAZVJYYDMSXG347` | permissioned (demo asset with BENJI's flags) |

## Units

- Shares and asset amounts are integers in stroops: 7 decimals, so
  `10000000` is one share.
- Prices are USD with 8 decimals.
- Every vector a fund returns (`quote_issue`, `holdings`, `units_per_share`)
  is in `components()` order.

## Setup

```
export STELLAR_RPC_URL=https://rpc.lightsail.network
export STELLAR_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
stellar keys add me        # your own key; never paste it into a file or chat
```

Mainnet's inclusion fee runs above the CLI default, so pass
`--inclusion-fee 1000` on every transaction. Reads use `--send=no`, which
simulates and needs no fee.

## Contract functions

**Fund** (one per fund)

| Function | Who | What |
| --- | --- | --- |
| `issue(investor, to, shares)` | investor | Pulls the basket for `shares` from `investor`, mints to `to`; returns amounts pulled |
| `redeem(from, to, shares, skip)` | holder | Burns shares, pays the pro-rata basket; legs in `skip` are booked as owed instead |
| `withdraw_owed(owner, to, token)` | owner | Pays a leg an earlier redeem skipped |
| `quote_issue(shares)` / `quote_redeem(shares)` | anyone | What an issue costs or a redeem pays, per component |
| `components()` | anyone | Tokens and initial units |
| `holdings()` | anyone | Live balances net of owed claims |
| `units_per_share()` | anyone | Assets behind one whole share |
| `owed(owner, token)`, `total_supply()`, `manager()`, `platform()`, `compliance()`, `is_investor(investor)`, `nav()` | anyone | Views |
| `set_investor(investor, allowed)` | manager | Investor allowlist |
| `set_compliance(Open \| Allowlist)` | manager | `Open` only if every component is `Open` on the shelf |
| `rebalance(sell, sold, buy, bought)` | manager | Swap one component for another inside the fund, bounded by oracle prices |
| `set_nav(nav)` | platform admin | The oracle that bounds rebalances |
| `open_for_issue()`, `is_open()` | manager, once | Ends setup; `issue` fails with `IssuanceClosed` before it |
| `set_mandate(Locked \| Managed \| Static)`, `mandate()` | manager, once, before `open_for_issue` | `Locked` (the default) freezes the set of components but can rebalance and trade; `Managed` also allows `add_component`; `Static` never rebalances, trades or adds (`MandateStatic`) |
| `add_component(token)` | manager, `Managed` only | Adds a shelf asset at zero units; a permissioned one needs `Allowlist` |
| `init_fee(rate_bps)` | manager, once, before `open_for_issue` | Annual management fee, at most 500 bps, streamed as newly minted shares |
| `accrue_fee()` | anyone | Mints the fee accrued so far; `issue`, `redeem` and (v0.6) `burn` and `burn_from` call it first. From v0.6 the unminted fraction of a share carries to the next accrual |
| `pending_fee()`, `fee()`, `fee_recipient()`, `platform_fee()` | anyone | Fee views |
| `set_fee_recipient(recipient)` | manager | Where the manager's part of the fee is minted (default: the manager); must pass the allowlist |
| `fee_escrow(recipient)`, `claim_fee(recipient)` | anyone | Fee shares held for a recipient that could not hold them when they accrued, and their release once it can |
| `set_platform_fee(share_bps, recipient)` | platform admin | The platform's cut of the fee, at most 5000 bps of it; recipient must pass the allowlist |
| `set_metadata(key, value)`, `metadata()` | manager / anyone | Up to 8 entries such as `description`, `strategy`, `website`, 512 bytes each; an empty value removes one |
| `trade(sell, sold, buy, min_bought, path)` | manager, not `Static` | Swap inside the fund through the Soroswap router; min out is the larger of `min_bought` and 99% at oracle prices; returns the amount bought |
| `set_router(router)`, `router()` | platform admin / anyone | The DEX router `trade` uses; `mainnet` builds default to Soroswap's |
| `window_loss_ppb()`, `month_loss_ppb()`, `last_rebalance()` | anyone | Trade loss used in the rolling 24 hour window and (v0.6) the 30-day window, in parts per billion of fund value, and the last rebalance time |
| SEP-41: `balance`, `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`, `decimals`, `name`, `symbol` | | Standard token interface |

**Platform**

| Function | Who | What |
| --- | --- | --- |
| `create_fund(manager, name, symbol, components, compliance, salt)` | allowlisted manager | Deploys a fund; every component must be on the shelf, and a permissioned one forces `Allowlist` |
| `set_manager(manager, allowed)` | admin | Manager allowlist |
| `set_shelf_asset(token, Unlisted \| Open \| Permissioned)` | admin | Asset shelf |
| `shelf()`, `shelf_status(token)`, `is_manager(manager)`, `is_fund(fund)`, `fund_count()`, `funds(start, limit)` | anyone | Views; `funds` pages at most 50 |

**Timelock** (admin of the v4 and demo platforms; constructor from v0.6:
`proposers, executors, delay, min_delay`, with `min_delay` at least 300 s)

| Function | Who | What |
| --- | --- | --- |
| `schedule(proposer, target, fn_name, args, salt)` | proposer | Queues `target.fn_name(args)`; returns the operation id |
| `execute(executor, target, fn_name, args, salt)` | executor | Runs it once the delay has passed, with the timelock as caller; from v0.6 it expires 14 days after it became ready (`Expired`) |
| `cancel(proposer, id)` | proposer | Drops a pending or expired operation. From v0.6 a `set_proposers` can be cancelled only by a proposer on its new list (`CannotCancel`) |
| `hash_operation(target, fn_name, args, salt)`, `operation(id)`, `delay()`, `min_delay()` (v0.6), `proposers()`, `executors()` | anyone | Views |
| `set_delay(delay)` | the timelock itself, through `schedule` and `execute` | Changes the delay, between `min_delay()` (v0.6) and 30 days |
| `set_proposers(list)`, `set_executors(list)` (v0.6) | the timelock itself, through `schedule` and `execute` | Replaces a role list, one to ten members |

**NAV** (read-only, holds nothing)

| Function | What |
| --- | --- |
| `price(token)` | USD price, timestamp, source, and divergence in bps when both oracles are fresh; from v0.6 also `secondary_timestamp`, when the confirming reading was taken, and `from_primary`, false when the price is a fallback |
| `nav(fund)` | Per-share value, each leg's units, price, value, source and age, and the fund total. Errors if any leg is unpriced |

**Zap** (stateless, holds nothing; constructor from v0.6: `router, usdc,
platforms`)

| Function | Who | What |
| --- | --- | --- |
| `issue_with_usdc(investor, fund, shares, max_usdc, paths)` | investor | Takes up to `max_usdc`, buys each leg exact-out on Soroswap, issues `shares` to the investor, refunds the rest; returns USDC spent |
| `redeem_to_usdc(owner, fund, shares, min_usdc, paths)` | owner | Redeems `shares` to the zap, sells what each leg delivered for USDC, pays the owner at least `min_usdc`; returns USDC paid |
| `router()`, `usdc()`, `platforms()` (v0.6) | anyone | The Soroswap router, USDC contract and trusted platforms set at deploy |

`paths` is one Soroswap route per non-USDC component, in `components()`
order: USDC to the leg for issue, the leg to USDC for redeem, 2 to 4
addresses. Errors: `InvalidPath` (1), `SlippageExceeded` (2),
`InvalidAmount` (3), `MissingPath` (4), `Overflow` (5), and from v0.6
`UnknownFund` (6: no trusted platform created `fund`), `DuplicateComponent`
(7), `InvalidPlatforms` (8), `HoldingsChanged` (9: the call would change
what the zap holds). The v0.5 zap on mainnet serves any contract named as
`fund`; check `platform.is_fund(fund)` before calling it.

## Read NAV

```
stellar contract invoke --id CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC \
  --source-account me --send=no -- nav --fund CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB

stellar contract invoke --id CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC \
  --source-account me --send=no -- price --token CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP
```

RedStone prices go stale after 26 hours, Reflector after 15 minutes. A
stale primary falls back to the secondary; if neither is fresh, `nav`
refuses rather than skip a leg.

## Invest

1. Read the cost of the shares you want:
   ```
   stellar contract invoke --id CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB \
     --source-account me --send=no -- quote_issue --shares 10000000
   ```
2. Hold every component in at least those amounts. Each needs a trustline;
   buy on the SDEX (the app's "Buy the basket" does it in one path-payment
   transaction, routing only direct or through Circle USDC).
3. If the fund's `compliance` is `Allowlist`, the manager must
   `set_investor` your address first. For a permissioned asset, the issuer
   must also authorize both you and the fund.
4. Issue:
   ```
   stellar contract invoke --id CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB \
     --source-account me --inclusion-fee 1000 -- \
     issue --investor <YOUR_G_ADDRESS> --to <YOUR_G_ADDRESS> --shares 10000000
   ```

`issue` is refused while any asset holds less than the fund owes past
redeemers, so new money never covers an impaired leg.

## Redeem

```
stellar contract invoke --id CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB \
  --source-account me --inclusion-fee 1000 -- \
  redeem --from <YOUR_G_ADDRESS> --to <YOUR_G_ADDRESS> --shares 10000000 --skip '[]'
```

If an issuer has frozen one asset for you, put its contract in `--skip`;
that leg becomes an owed claim and the rest pays now. Collect it later:

```
stellar contract invoke --id CCBONNERPF2UQGMRTOJELOSA574VDY6XFRNKLLVBZNLLEULZ65UYPWJJ \
  --source-account me --inclusion-fee 1000 -- \
  withdraw_owed --owner <YOUR_G_ADDRESS> --to <YOUR_G_ADDRESS> \
  --token CCDKWOUML7ZBLXBWCLLX2BAWW5OCSU3BYCASK7KHSGAZVJYYDMSXG347
```

`redeem` takes no minimum-out. Per-share value can fall between quote and
execution through an issuer clawback or freeze, a manager `rebalance` or
`trade` landing first (within the trade bounds), or fee accrual.

## Invest or cash out with USDC

The zap does the swaps and the issue (or the redeem and the swaps) in one
transaction, with one signature. It works for funds whose every non-USDC
leg has a Soroswap pool: today XLM and USTRY, so aLQD (USDC, USTRY, XLM)
but not funds holding USDY, CETES or BENJI. The investor must pass the
fund's allowlist, if it has one; the zap does not need to.

1. Read the components and the cost, and build one path per non-USDC leg in
   `components()` order. For aLQD that is USTRY then XLM:
   ```
   stellar contract invoke --id CC5QR5OOQMCPVSL3SJMH7QESCFINWUMX3427CT4NIDBS3FRVDHAM4NAJ \
     --source-account me --send=no -- quote_issue --shares 1000000
   ```
2. Simulate, check the USDC spent, then send the same call without
   `--send=no` and with `--inclusion-fee 1000`. Set `max_usdc` a little
   above the simulated spend; the rest is refunded.
   ```
   stellar contract invoke --id <ZAP> --source-account me --send=no -- \
     issue_with_usdc --investor <YOUR_G_ADDRESS> \
     --fund CC5QR5OOQMCPVSL3SJMH7QESCFINWUMX3427CT4NIDBS3FRVDHAM4NAJ \
     --shares 1000000 --max_usdc 1100000 \
     --paths '[["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75","CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR"],["CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75","CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"]]'
   ```
3. Cash out the same way, with the paths reversed and `min_usdc` a little
   under the simulated payout:
   ```
   stellar contract invoke --id <ZAP> --source-account me --send=no -- \
     redeem_to_usdc --owner <YOUR_G_ADDRESS> \
     --fund CC5QR5OOQMCPVSL3SJMH7QESCFINWUMX3427CT4NIDBS3FRVDHAM4NAJ \
     --shares 1000000 --min_usdc 1000000 \
     --paths '[["CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR","CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"],["CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA","CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"]]'
   ```

`SlippageExceeded` means the basket cost more than `max_usdc` or paid less
than `min_usdc`. The zap cannot skip a frozen leg; use `redeem` with
`--skip` for that.

## Create a fund

The manager address must be allowlisted on the platform (`is_manager`),
and every component must be on the shelf (`shelf`, `shelf_status`).
`initial_units` price only the first share. Funds created from fund code
v0.4.0 (not yet released) start closed: set the fee and mandate if
wanted, then call `open_for_issue` before anyone can invest.

```
stellar contract invoke --id CDV2FJ4J2IIFSUREC5VAHINVCSVZGOMIMXJHA32XD7H2CMY6DNXD6KDM \
  --source-account manager --inclusion-fee 1000 -- \
  create_fund --manager <MANAGER_G_ADDRESS> --name "My Treasury Fund" --symbol aMINE \
  --components '[{"token":"CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75","initial_units":"5000000"},{"token":"CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP","initial_units":"5000000"}]' \
  --compliance '"Open"' --salt "$(openssl rand -hex 32)"
```

It returns the new fund's contract ID. A fund holding a permissioned asset
(BENJI, DEMOMMF) must use `'"Allowlist"'`. Managers can do the same from the
app at `/create`, with one wallet signature.

## Rebalance

The manager swaps `sold` of one component for `bought` of another inside
the fund. The manager sends in `bought` of `buy`; the fund sends out `sold`
of `sell`. The trade must be worth at least 99% of what leaves the fund at
NAV oracle prices (`MAX_REBALANCE_LOSS_BPS = 100`), or it fails with
`PriceTooLow`. The fund needs its NAV set by the platform admin
(`set_nav`), or it fails with `NoOracle`. Rebalance ships in fund code
v0.3.0; funds are not upgradeable, so it is on aREBAL and funds created
after it.

From fund code v0.4.0 (not yet released) a rebalance fails in a `Static` fund (`MandateStatic`), comes at least 60 seconds after
the previous one (else `RebalanceCooldown`), and fails with
`LossBudgetExceeded` once everything given up against the oracle inside a
rolling 24 hours would pass 2% of fund value. A fund with no `set_nav`
falls back to the NAV contract compiled into a `mainnet` build.

From fund code v0.6.0 both legs of a `rebalance` or `trade` need a NAV
price from the route's primary (`UnconfirmedPrice` when `from_primary` is
false) at most 15 minutes old (`StalePrice`). Any second reading must be
within 2% (`PriceDivergence`); its divergence counts as value given up,
at least 50 bps unless it is also at most 15 minutes old, and a leg with
no second reading counts 50 bps. A second budget caps losses at 5% of
fund value over 30 days. A v0.6 fund needs a v0.6 NAV (set with
`set_nav`); the current mainnet NAV's quotes lack `from_primary` and
`secondary_timestamp`. Check `price` for both tokens first: on today's
routes every trade price leans on a RedStone reading (directly, or
through the USDC to USD conversion for Reflector prices), so trades pass
only in the 15 minutes after a RedStone update.

```
stellar contract invoke --id CAZ7FRP7M5RMLGGOPQZNZMIEN7ACNLVBG7AOVEBGBCBYH6JVUCLTDCTD \
  --source-account manager --inclusion-fee 1000 -- \
  rebalance --sell CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 --sold 1000000 \
  --buy CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA --bought 5900000
```

Before signing, check `price` for both tokens and confirm
`bought * price(buy) >= 0.99 * sold * price(sell)`. Where the manager
sources the bought asset (SDEX, an RFQ desk) is up to them.

Fund code v0.4.0 (not yet released) adds `trade`, which swaps inside the
fund through the Soroswap router instead of through the manager's
wallet. Soroswap has usable pools only for XLM/USDC and USDC/USTRY today;
see docs/how-it-works.md for the measured reserves. Agent-run rebalancing
under a manager policy (target weights, drift bands, spend limits) is on
the roadmap. It is not shipped.

## CLI

`scripts/alloy.sh` wraps the journey and records every transaction in
`deployments/$NETWORK.json`:

```
NETWORK=mainnet scripts/alloy.sh <command> [args]
```

| Command | What |
| --- | --- |
| `shelf` | List shelf assets |
| `buy CODE AMOUNT_STROOPS [IDENTITY]` | Buy an exact amount with XLM on the SDEX |
| `create-fund NAME SYMBOL Open\|Allowlist CODE=UNITS...` | Create a fund |
| `allowlist SYMBOL ADDRESS` | Manager allowlists an investor |
| `issue SYMBOL SHARES_STROOPS` | Quote, then issue |
| `redeem SYMBOL SHARES_STROOPS [SKIP_CODE...]` | Redeem, optionally skipping legs |
| `status SYMBOL` | Supply, components, holdings, units per share |
| `nav SYMBOL` | Oracle NAV per share, or each leg's price when one is unpriced |
| `set-nav FUND_CONTRACT` | Admin points a fund's rebalance bound at the NAV oracle |
| `authorize-fund SYMBOL CODE` | Issuer lets the fund hold its asset |

Admin and setup commands: `build`, `deploy`, `set-fund-wasm`,
`issue-asset`, `add-asset`, `mainnet-assets`, `fund-investor`,
`clawback-drill`, `nav-deploy`, `nav-route`, `mainnet-nav-routes`.

## Safety rules

- Never ask for, store, or print a private key. Use `stellar keys` identities.
- Simulate first (`--send=no`, or `quote_issue` / `quote_redeem`) and show
  the amounts before signing.
- Use only the contract and asset IDs above. Never resolve an asset by its
  code; lookalike issuers are common.
- Check `platform.is_fund(fund)` before treating any contract as an Alloy fund.
- Mainnet transactions need `--inclusion-fee 1000`.
- The contracts are unaudited. Keep amounts small.
