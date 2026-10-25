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

## Builds you can verify

Every `v*` tag builds both contracts in CI from the tagged commit, stamps
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
- An asset reclassified `Permissioned` after a fund opened does not force
  that fund back to an allowlist. The issuer's asset contract still refuses
  unauthorized holders.
