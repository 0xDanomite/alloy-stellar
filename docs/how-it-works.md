# How Alloy funds work on Stellar

An Alloy fund is a SEP-41 token whose shares are a basket of Stellar assets.
Investors deposit the basket and receive shares; they hand shares back and
receive the basket. Two contracts do all of it: `fund` (one per fund) and
`platform` (one per venue).

## Accounting

Positions are never stored. One share is worth

```
(fund's balance of each asset - amounts owed to past redeemers) / shares outstanding
```

so whatever moves a balance moves the books with it:

- an issuer claws back from the fund: value per share falls pro rata;
- someone sends the fund an asset: value per share rises for every holder;
- rounding dust from issues and redeems belongs to holders, and redeeming
  the last share empties the fund.

`initial_units` set by the manager only price the first share, while no
shares exist. Anything an empty fund still holds is credited to the manager
as an owed claim, so it is never the next investor's windfall.

Rounding always favors the fund: issue rounds what you pay up, redeem
rounds what you receive down.

## Guarantees

| Promise | How it holds | Test |
| --- | --- | --- |
| Nobody can stop a redemption | `redeem` has no pause, no manager gate; the platform has no function that touches a deployed fund | `redeem_works_whatever_the_manager_does` |
| An issuer freezing one asset does not trap the rest | Redeem can skip a leg; it becomes an owed claim paid later by `withdraw_owed` | `frozen_leg_can_be_skipped_and_claimed_later` |
| A clawback never blocks redemption | Holdings floor at zero; owed claims rank ahead of holders | `clawback_below_owed_reserve_never_blocks_redeem` |
| New money never covers an impaired asset | `issue` is refused while any asset holds less than it owes | `issue_is_blocked_while_a_leg_is_short_of_owed_claims` |
| The fund is always solvent | Holdings cover every outstanding share at all times | `test_reference_model` (property test) |
| The management fee never blocks a redemption | Accrual uses no external call and mints nothing on overflow | `fee_accrual_never_blocks_a_redemption` |
| A locked fund's basket never changes | `Locked` is the default and can only be swapped for `Managed` before `open_for_issue` | `a_fund_is_locked_unless_its_manager_chose_managed_before_opening` |
| Nobody can buy in ahead of the manager's setup | `issue` is refused until the manager calls `open_for_issue`; fee and mandate are only settable before it | `nobody_can_issue_before_the_manager_opens_the_fund` |
| Fee shares never land outside the allowlist | A recipient that can't hold shares has them held by the fund in escrow until `claim_fee` | `fee_for_a_recipient_off_the_allowlist_waits_in_escrow` |
| A manager cannot bleed value through many small bad fills | Oracle losses across rebalances are capped at 2% of fund value per rolling 24 hours, one minute apart | `losses_inside_a_day_are_capped_at_two_percent_of_fund_value` |

## Setup, then open

A new fund is closed: `issue` fails with `IssuanceClosed` until the
manager calls `open_for_issue`. The fee and the mandate can only be set
while the fund is closed, so the terms an investor buys into are final
and nobody can issue first to lock the manager out of setting them.

## Management fee

A manager may set one annual fee, at most 5% (`MAX_FEE_BPS = 500`), with
`init_fee` before `open_for_issue`. It can never be changed after.
The fee is paid in new shares, never in assets: for `t` seconds at rate
`r`, the fund mints

```
supply * f / (1 - f),   f = r * t / one year
```

so the new shares own exactly `f` of the fund afterwards. `issue` and
`redeem` accrue first, and anyone can call `accrue_fee`. `quote_issue` and
`quote_redeem` include the pending fee, so a quote matches the call made in
the same ledger. One accrual covers at most a year; time beyond that is
not charged.

The platform admin may take a cut of each fund's fee, at most half
(`MAX_PLATFORM_SHARE_BPS = 5000`), minted to a recipient it names. The cut
splits the fee; it never raises it. The manager's part goes to the manager
or to a recipient the manager sets. Both recipients must pass the fund's
allowlist when they are set. If a recipient can't hold shares when the fee
accrues (the default recipient, the manager, was never allowlisted, or a
recipient was removed), the fund mints its part to itself and holds it in
escrow (`fee_escrow`); anyone can call `claim_fee(recipient)` once the
recipient is allowed, and the shares go only to that recipient. Dilution
is the same either way.

## Mandate

Every fund is `Locked` or `Managed`, chosen once by the manager before the
fund opens for issue. A fund that never chooses is `Locked`, the safer
reading for an investor: its components never change and it never
rebalances, so a share always holds the same assets in the same
proportions; only the fee, clawbacks and donations change the amounts. A `Managed` fund may
rebalance and `add_component` any asset the platform shelf lists (a
`Permissioned` one only with the investor allowlist on), up to 12
components. An added asset starts at zero units and gains weight only
through rebalances.

## Metadata

Managers describe a fund with `set_metadata(key, value)`: up to 8 entries
(`description`, `strategy`, `website`, ...), 512 bytes each, read with
`metadata()`. It is display data and changes nothing on chain.

## Rebalance bounds

Every rebalance is checked against the NAV oracle three ways:

- each trade must return at least 99% of what leaves the fund;
- what all trades gave up must stay within 2% of fund value over any
  rolling 24 hours (`MAX_WINDOW_LOSS_BPS = 200`). Each losing trade is
  logged with its loss as a share of fund value at that moment, and drops
  out of the log a day later. At most 32 losing trades can be live at
  once; gains are not logged and cost nothing;
- trades are at least 60 seconds apart.

A non-positive oracle price is refused (`BadPrice`). Legs the fund holds
none of are not priced, so a newly added, still-empty asset needs no feed.

The oracle is whatever the platform admin set with `set_nav`. A build
with the `mainnet` cargo feature falls back to the mainnet NAV contract
when none is set; default and `testnet` builds have no fallback.

The property test drives random funds through random sequences of issues
and partial redeems and compares every step against a fixed-unit basket
model: same prices up to rounding dust, same solvency, full emptying at the
end. Breaking the contract's rounding makes it fail.

## Issuer rails

Some Stellar assets are permissioned: the issuer sets `AUTH_REQUIRED`, so
every holder, contracts included, must be authorized first (BENJI works
this way). Alloy treats that as a first-class case:

- The platform lists each asset on its shelf as `Open` or `Permissioned`.
- A fund holding a permissioned asset must run an investor allowlist, and
  its manager cannot switch the allowlist off while that asset is held.
- Until the issuer calls `set_authorized(fund, true)` on its asset
  contract, deposits into the fund fail at the asset contract itself.
- Revocable and clawback flags are survivable (see Accounting).

## Platform

- `create_fund` is the only way funds are made; `is_fund` is the authority
  on whether a contract is a genuine Alloy fund.
- Managers and assets are allowlisted by the platform admin. The admin is
  a single address today and moves to a timelock with `set_admin`.
- Funds are stored one ledger entry each and listed with
  `funds(start, limit)`.

## Buying the basket

Most tokenized-asset liquidity on Stellar is on the built-in order book
(SDEX), which contracts cannot trade on. The app buys the basket with
path payments in one classic transaction (direct or via Circle USDC only),
then calls `issue` in a second. Two signatures, one flow.

## Pricing

Funds never need a price: issue and redeem move assets in proportion to
what the fund holds, so no oracle can make a share mint cheap or redeem
rich. Prices are for showing what a share is worth, and they come from a
separate read-only `nav` contract that holds nothing and only calls fund
views (`components`, `units_per_share`, `total_supply`).

- Each asset has an admin-set primary route and an optional secondary,
  each naming an oracle contract, what to ask it for, its quote unit and
  a maximum age. Mainnet routes: RWAs (USDY, USTRY, CETES) on
  [RedStone](https://redstone.finance) first and
  [Reflector](https://reflector.network) second where it covers them;
  XLM and USDC on Reflector first and RedStone second. BENJI is on neither
  SEP-40 contract, so it reads RedStone's single-feed BENJI contract
  (`BENJI_ETHEREUM_FUNDAMENTAL`, the fund's published NAV).
- A primary that is stale, missing, future-dated, or fails in any way
  (a trap, a wrong shape, an overflow) falls back to the secondary. If
  neither is fresh the asset is unpriced, and so is the fund: `nav`
  refuses rather than skip a leg.
- Staleness limits follow each feed's heartbeat: 26 hours for RedStone
  (12 to 24 hour updates), 15 minutes for Reflector (5 minute updates).
- When both oracles are fresh, `price` reports how far apart they are in
  basis points. Reflector quotes in USDC; those prices are converted with
  RedStone's USDC/USD price, never assumed to be 1:1.
- Prices are USD with 8 decimals. `nav(fund)` returns per-share value for
  one whole share, each leg's units, price, value, source and age, and the
  fund total. The app shows the SDEX price beside it as a market
  cross-check and flags legs more than 2% apart.

## Builds you can verify

Every `v*` tag builds every contract in CI from the tagged commit, stamps
`source_repo` into the WASM, attests it (SEP-0055) and attaches it to a
GitHub release. Mainnet deploys download that release and check its
attestation first:

```
gh attestation verify alloy-fund_v0.1.0.wasm -R 0xDanomite/alloy-stellar
```

## Known limitations

- Unaudited. Keep amounts small.
- Neither contract is upgradeable. That keeps the redemption promise
  absolute; a bug in `issue` can only be contained per fund (the manager
  closes the allowlist).
- `redeem` takes no minimum-out; per-share value can only fall between
  quote and execution through an issuer clawback or freeze.
- Oracle routes are set by a single admin key, like the platform; a
  wrong route mislabels share value on screen but cannot move assets.
- Release builds compile no network feature, so released fund code has no
  default oracle; the platform admin still sets one per fund.
- An asset reclassified `Permissioned` after a fund opened does not force
  that fund back to an allowlist. The issuer's asset contract still refuses
  unauthorized holders.
