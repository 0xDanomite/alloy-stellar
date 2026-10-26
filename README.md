# Alloy on Stellar

**Live on Stellar Mainnet**

Multi-asset fund tokens for wealth managers: one share holds a basket of
Stellar's tokenized treasuries, stablecoins and money-market funds,
priced on chain by RedStone and Reflector, and redeemable for the assets
underneath at any time.

**Live app:** [alloy-stellar.vercel.app](https://alloy-stellar.vercel.app) · **Create a fund:** [/create](https://alloy-stellar.vercel.app/create) · **Pitch deck:** [deck](https://claude.ai/artifact/D2Epdk9Z7XFDSz6Qg8Y7iG) · **New code since arrival:** [arrival...submission](https://github.com/0xDanomite/alloy-stellar/compare/arrival...submission)

**For AI agents:** [AGENTS.md](AGENTS.md) (working in this repo) · [SKILL.md](SKILL.md) (using Alloy on mainnet)

**Tracks:** Scale, Stellar Composed (Soroban contracts + SDEX path payments + RedStone and Reflector oracles + Stellar Wallets Kit)

## At a glance

| | In one line | Proof |
| --- | --- | --- |
| What we started with | Alloy live in production on Robinhood Chain and Polygon; nothing on Stellar | [alloy.neevstack.com](https://alloy.neevstack.com), [`arrival` tag](https://github.com/0xDanomite/alloy-stellar/tree/arrival) |
| What we built at HackMeridian | Fund, platform and oracle NAV contracts, a CLI, an app where managers create and run funds from their wallet, and a mainnet launch | [arrival...submission](https://github.com/0xDanomite/alloy-stellar/compare/arrival...submission) |
| The problem we solve | Tokenized assets on Stellar come one per wrapper; managers can't hand a client one share of a portfolio | [How it works](docs/how-it-works.md) |
| What we bring to Stellar | A multi-asset fund layer built for permissioned assets, ported from our EVM product | [Platform contract](https://stellar.expert/explorer/public/contract/CDV2FJ4J2IIFSUREC5VAHINVCSVZGOMIMXJHA32XD7H2CMY6DNXD6KDM) |
| What makes it different | Issuer rails: funds that hold assets like BENJI, survive clawbacks, and never lock redemption | [Clawback drill on mainnet](https://stellar.expert/explorer/public/tx/f692a96a8aa7e1ec742ecb4fe1efbaef54e2c81bb5150d39e428e5949f893fa0) |
| How it works | Soroban contracts hold the basket; NAV from RedStone and Reflector; SDEX path payments buy it | [aTRSY issue](https://stellar.expert/explorer/public/tx/94489b5be5bdba25d51a29212a2d96075f74de2eb2ad46be468767ad50eb7c66) |
| Using the product | Managers create a fund from the shelf; investors buy the basket, deposit, hold one token, redeem any time | [alloy-stellar.vercel.app](https://alloy-stellar.vercel.app) |
| Business model & traction | Platform for managers and issuers; live EVM venues today | [alloy.neevstack.com](https://alloy.neevstack.com) |

## What We Started With

**Alloy is live in production on two EVM chains. None of it ran on Stellar.**

- [alloy.neevstack.com](https://alloy.neevstack.com): our own timelocked
  multi-asset fund protocol on Robinhood Chain (4663) and Polygon (137):
  - fund creator, mandate manager and fee splitter;
  - oracle adapters and a zap;
  - a manager console and an investor app.
- That codebase is private. This repository started empty at HackMeridian:
  the [`arrival`](https://github.com/0xDanomite/alloy-stellar/tree/arrival)
  tag is a README and a license.

## What We Built at HackMeridian

**A Stellar-native fund layer, written from scratch in Rust, live on mainnet
with three funds and on-chain oracle NAV.**

Before: no Alloy on Stellar.
After: funds of real tokenized assets that anyone can verify, buy into and
redeem on Stellar mainnet.

| What we built | Where |
| --- | --- |
| Fund contract: SEP-41 basket shares, in-kind issue, redeem nobody can pause, units from live balances (clawback-safe) | [contracts/fund](contracts/fund) |
| Platform contract: manager allowlist, asset shelf, permissioned assets force an investor allowlist | [contracts/platform](contracts/platform) |
| NAV contract: per-asset RedStone and Reflector routes, staleness limits, fallback, divergence | [contracts/nav](contracts/nav) |
| Verifiable builds: CI builds tagged releases from source and attests them (SEP-0055); deploys use only those binaries | [release workflow](.github/workflows/release.yml), [v0.2.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.2.0) |
| CLI for the whole journey, mainnet and testnet | [scripts/alloy.sh](scripts/alloy.sh), [scripts/mainnet-launch.sh](scripts/mainnet-launch.sh) |
| App: funds, oracle NAV, buy-the-basket, redeem, testnet/mainnet switch | [app](app) |
| Manager rebalancing (the Set-style trade module, on Soroban): the manager swaps one holding for another inside the fund, every share re-weights, and the contract rejects any fill worth under 99% at oracle prices | [fund contract](contracts/fund/src/lib.rs), [v0.3.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.3.0), [mainnet rebalance](https://stellar.expert/explorer/public/tx/4e6f2a9cb92a71face8823f4ce29c28189bd6fae5c6306cd29e3cd7462f257c5) |
| Create and manage funds from the wallet: approved managers pick shelf assets and units per share, preview launch NAV, deploy with one signature, then switch access and approve investors | [create page](app/src/pages/CreatePage.tsx), [commit](https://github.com/0xDanomite/alloy-stellar/commit/65a3815) |

What we learned about Stellar:

- **Liquidity is on the order book.** Most tokenized-asset liquidity sits
  on the classic order book (SDEX), which contracts can't trade on. So the
  app buys the basket with path payments in one transaction, and the
  contract only ever takes the assets in kind.
- **Issuers gate holders.** Issuers like Franklin Templeton set
  `AUTH_REQUIRED` and clawback. We designed around those flags, so a frozen
  or clawed-back asset never traps the rest of a redemption.
- **Fees moved under us.**
  - Testnet storage rent spiked about 2,700x above mainnet during the
    event.
  - Mainnet's minimum fee for contract transactions was above the CLI's
    default, so our launch scripts set their own fee.

What we tested:

- 44 contract tests, including a property test over random issue and
  redeem sequences.
- A mainnet fork test of the NAV contract against live oracle state.
- A review against the SDF smart-contract security guides and the
  community common-mistakes checklist from skills.stellar.org.
- Full rehearsals on testnet, then the same scripts on mainnet.

## The Problem We Solve

**Wealth managers can't hand clients one share of a portfolio of Stellar's
real-world assets. Alloy lets them build that fund, and lets investors
always redeem it.**

Stellar carries each of these in its own wrapper:

- tokenized treasuries: Ondo's USDY, Etherfuse's USTRY and CETES;
- stablecoins: Circle's USDC;
- registered money-market funds: Franklin Templeton's BENJI.

A manager who wants a diversified product today has to hold each asset
separately for each client. With Alloy the manager defines the basket
once, and investors get one SEP-41 token that holds it. They can redeem
it for the underlying assets whenever they want.

## What We Bring to Stellar

**A fund layer built for permissioned assets: the piece above single-asset
tokenization.**

- **Ported from:** Alloy's EVM fund platform (Robinhood Chain, Polygon),
  rewritten in Rust for Soroban rather than bridged.
- **Uses:**
  - Soroban contracts;
  - Stellar Asset Contracts for USDC, USDY, USTRY, CETES and BENJI;
  - issuer authorization and clawback flags;
  - SDEX path payments;
  - RedStone and Reflector oracles;
  - Stellar Wallets Kit (Freighter, xBull, Lobstr).
- **What Stellar gains:** a way to compose its tokenized assets into
  managed products. Every new issuer becomes a new ingredient.

## What Makes It Different

**Funds that hold issuer-permissioned assets, stay honest through
clawbacks, and never lock redemption.**

- **Clawback-safe accounting.** Positions come from live balances, not
  stored numbers. If an issuer claws back from the fund, value per share
  falls pro rata and every redemption still pays out. We ran
  [this drill on mainnet](https://stellar.expert/explorer/public/tx/f692a96a8aa7e1ec742ecb4fe1efbaef54e2c81bb5150d39e428e5949f893fa0).
- **Issuer rules carry through.** A fund holding a permissioned asset must
  run its own investor allowlist, and its manager can't switch it off.
- **One frozen asset doesn't block the rest.** If an issuer freezes one
  asset for a redeemer, that leg becomes a claim to collect later and the
  rest pays out now.
- **Ready for BENJI.**
  [aBENJI](https://stellar.expert/explorer/public/contract/CCIQFFLE5X3T3SWWOET2N2LIPQLEUDTGLOGCDCBPDOM67ARH6A26MKG5)
  holds a slot for real BENJI and opens the moment the issuer authorizes
  the fund's address.

## How It Works

**Two core Soroban contracts plus a read-only oracle NAV contract, all
deployed from an attested release.**

```
            platform (manager allowlist, asset shelf)
                 |  create_fund
     +-----------+-----------+
   aTRSY       aBENJI      aRAIL        <- fund contracts (SEP-41 shares)
     |  hold USDC, USDY, USTRY, CETES, XLM, BENJI, DEMOMMF via their SACs
     |
    nav  --reads-->  RedStone, Reflector (SEP-40 + RedStone feeds)

app: SDEX path payments buy the basket -> fund.issue; fund.redeem pays it back
```

All on Stellar Mainnet:

| Component | Mainnet Contract on Explorer |
| --- | --- |
| Platform | [CDV2FJ4J…6KDM](https://stellar.expert/explorer/public/contract/CDV2FJ4J2IIFSUREC5VAHINVCSVZGOMIMXJHA32XD7H2CMY6DNXD6KDM) |
| NAV | [CBO42GCY…ZVIC](https://stellar.expert/explorer/public/contract/CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC) |
| aTRSY, Alloy Stellar Treasury | [CAIJVJBR…C7UB](https://stellar.expert/explorer/public/contract/CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB) |
| aBENJI, Alloy Treasury + BENJI | [CCIQFFLE…MKG5](https://stellar.expert/explorer/public/contract/CCIQFFLE5X3T3SWWOET2N2LIPQLEUDTGLOGCDCBPDOM67ARH6A26MKG5) |
| aRAIL, Issuer Rails Demo | [CCBONNER…PWJJ](https://stellar.expert/explorer/public/contract/CCBONNERPF2UQGMRTOJELOSA574VDY6XFRNKLLVBZNLLEULZ65UYPWJJ) |
| DEMOMMF (demo asset with BENJI's flags) | [asset](https://stellar.expert/explorer/public/asset/DEMOMMF-GAPHKRSKDAJYL6FYCRBIIY4M6QP32CM6WOKPNGOOKZ3EQ52LW2K4Q2HM) |
| Seed issue of aTRSY | [tx](https://stellar.expert/explorer/public/tx/94489b5be5bdba25d51a29212a2d96075f74de2eb2ad46be468767ad50eb7c66) |
| Issuer authorizes aRAIL | [tx](https://stellar.expert/explorer/public/tx/73cbec3c624226ff92ea1ff33f2b72f5c99ec1e59d4553eec9d5ac3d5824a291) |
| Clawback drill (1.0 to 0.75 DEMOMMF per share) | [tx](https://stellar.expert/explorer/public/tx/f692a96a8aa7e1ec742ecb4fe1efbaef54e2c81bb5150d39e428e5949f893fa0) |
| Rebalance: aREBAL sells 0.1 USDC for 0.59 XLM, units per share 0.1/1.0 to 0.05/1.295 | [tx](https://stellar.expert/explorer/public/tx/4e6f2a9cb92a71face8823f4ce29c28189bd6fae5c6306cd29e3cd7462f257c5) |
| Fund code v0.3.0 set on the platform | [tx](https://stellar.expert/explorer/public/tx/28f8cd13d8fddfabfe1cf37ec1bcb8057a311deb385715f96e3fcdd3747da468) |
| Redeem after the clawback | [tx](https://stellar.expert/explorer/public/tx/1fbd0e1a0d80303d243d60282a2b1360c9760e4e6ad21b3d5a71084a094062f0) |

Every transaction from the launch is in
[deployments/mainnet.json](deployments/mainnet.json).

The contracts come from the attested
[v0.2.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.2.0)
release. To verify one:

```
gh attestation verify alloy-fund_v0.1.0.wasm -R 0xDanomite/alloy-stellar
```

Details: [docs/how-it-works.md](docs/how-it-works.md).

## Using the Product

**Pick a fund, buy the basket, deposit, and hold one token you can redeem
any time.**

**Managers:** open [Create fund](https://alloy-stellar.vercel.app/create),
connect an approved manager wallet, tick assets from the shelf, set what one
share holds, and sign. The fund deploys as its own contract and appears in
the app. Its Manage tab switches who may invest and approves investors.

**Investors:**

1. Open the app and pick a fund. Each asset in it shows its oracle price,
   that price's source and age, and the live market price as a
   cross-check.
2. Connect a wallet (Freighter, xBull or Lobstr). "Buy the basket" buys
   every asset on the Stellar DEX in one transaction.
3. "Deposit" sends the basket into the fund and mints your shares.
4. "Redeem" returns the basket, any time.

The switch in the header moves between mainnet and testnet.

## Business Model & Traction

**Alloy is the fund layer that managers, banks and issuers build on.**

- **Before HackMeridian:** live in production on Robinhood Chain and
  Polygon ([alloy.neevstack.com](https://alloy.neevstack.com)).
- **On Stellar:**
  - Managers pay platform fees to launch and run funds, alongside their
    own management fees.
  - Banks and wealth managers get white-label model-portfolio rails.
  - Issuers get distribution: their asset inside managed portfolios, with
    their holder rules enforced.
- **Next steps:**
  1. An independent audit.
  2. Streaming fees and a timelocked admin.
  3. A cumulative loss budget and cooldown on rebalances, on top of the
     per-trade 1% oracle bound.
  4. Agent-run funds: a manager agent with a policy (target weights, drift
     bands, oracle-checked minimums, spend limits) rebalances through
     Soroswap's aggregator, which can now execute swaps on an agent's behalf.
     The manager sets the rules; the agent runs them; investors can still
     always redeem.
  5. Fund-share NAV as a SEP-40 price feed, and an aTRSY/USDC pool, so fund
     shares work as collateral across Stellar DeFi.
  6. Issuer authorizations, starting with BENJI.
  7. Private, ZK-verified investor allowlists.

## Our Team

**Two founders who have built together for almost ten years, across web2 and web3.**

- **Dan**, co-founder: builds Alloy's contracts, app and infrastructure.
- **Vik**, co-founder: leads Alloy's product, partners and fund managers.

Together we shipped Alloy on Robinhood Chain and Polygon before bringing it to Stellar at HackMeridian.

## Run It

1. Install Rust with the `wasm32v1-none` target, stellar-cli 25.2+, Node 22
   and jq.
2. Copy `.env.example` to `.env`.
3. Run the tests with `cargo test`, and the app with
   `cd app && npm ci && npm run dev`.
4. Rehearse the full journey on testnet with `scripts/testnet-launch.sh`
   (throwaway keys, funded from friendbot).
5. On mainnet, run `scripts/mainnet-launch.sh`, using identities in your
   local `stellar keys` and the attested release.

## License

[Apache-2.0](LICENSE)
