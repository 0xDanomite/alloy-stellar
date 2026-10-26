# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

Alloy on Stellar: multi-asset fund tokens for wealth managers, live on
Stellar mainnet. One fund share is a SEP-41 token that holds a basket of
Stellar assets (USDC, USDY, USTRY, CETES, XLM, BENJI). Investors deposit the
basket in kind and get shares; they hand shares back and get the basket.
Redemption can never be paused. Prices come from RedStone and Reflector
through a read-only NAV contract.

To use the protocol (invest, redeem, create a fund, rebalance, read NAV),
read [SKILL.md](SKILL.md). For the design and its guarantees, read
[docs/how-it-works.md](docs/how-it-works.md).

## Repo map

| Path | What it holds |
| --- | --- |
| `contracts/fund` | Fund contract, one per fund: SEP-41 shares, `issue`, `redeem`, `withdraw_owed`, `rebalance`, `trade` (Soroswap), investor allowlist, streaming fee (`init_fee`, `accrue_fee`), mandate (`set_mandate`, `add_component`), `set_metadata` |
| `contracts/platform` | Platform contract, one per venue: manager allowlist, asset shelf, `create_fund`, fund registry |
| `contracts/nav` | Read-only NAV contract: per-asset RedStone and Reflector routes, staleness limits, fallback, divergence |
| `app` | Vite + React app: fund pages, oracle NAV, buy the basket via SDEX path payments, deposit, redeem, create and manage funds |
| `scripts/alloy.sh` | CLI, one command per journey step, testnet and mainnet |
| `scripts/lib.sh` | Shared network config, identities, `invoke` and `view` helpers |
| `scripts/testnet-launch.sh`, `scripts/mainnet-launch.sh` | Full launch rehearsals |
| `deployments/mainnet.json` | Mainnet contract IDs, asset contracts, and every launch transaction |
| `.github/workflows` | `test.yml` (tests), `release.yml` (attested release builds) |

## Build and test

Prerequisites: Rust with the `wasm32v1-none` target, stellar-cli 25.2+,
Node 22, jq.

```
cargo test --workspace            # contract tests, including the property test
stellar contract build            # wasm to target/wasm32v1-none/release
cd app && npm ci && npm run build # typecheck + production build
cd app && npm run dev             # local app
```

Copy `.env.example` to `.env` before running scripts or the app.

## Conventions

- Contracts are Rust on soroban-sdk 29, one crate per contract under
  `contracts/`, in a single Cargo workspace.
- Share and asset amounts are integers in stroops (7 decimals). Prices are
  USD with 8 decimals.
- Positions are never stored: holdings come from live balances. Keep it
  that way; it is what makes clawbacks survivable.
- Rounding always favors the fund: issue rounds up, redeem rounds down.
- `redeem` must stay ungated. Never add a pause, a manager check, or a
  platform hook that can stop it.
- Contracts are not upgradeable. A behavior change ships as new fund code
  set on the platform with `set_fund_wasm`; existing funds keep their code.
- Every contract change comes with a test in the same crate.
- Commit style: `area: what changed`, lowercase, imperative.

## Mainnet safety

- **Verified builds only.** Mainnet deploys require `RELEASE_TAG`. The CLI
  downloads that GitHub release's wasm and runs `gh attestation verify`
  (SEP-0055) before using it, and refuses a local build on mainnet:
  ```
  gh attestation verify alloy-fund_v0.1.0.wasm -R 0xDanomite/alloy-stellar
  ```
- **Inclusion fee 1000.** Mainnet's Soroban inclusion fee runs above the
  CLI's 100-stroop default; under it, transactions wait out their timeout.
  `scripts/lib.sh` sets `STELLAR_INCLUSION_FEE=1000` on mainnet. Pass
  `--inclusion-fee 1000` when invoking by hand.
- **RPC.** Mainnet uses `https://rpc.lightsail.network` (override with
  `MAINNET_RPC_URL`). Network passphrase:
  `Public Global Stellar Network ; September 2015`.
- **Never commit secrets.** Keys live only in your local `stellar keys`
  config; `.env` holds identity names, never keys. Mainnet uses identities
  added with `stellar keys add`; testnet generates throwaway ones.
- **Pinned issuers.** Asset issuers are pinned in `scripts/alloy.sh` and
  `deployments/mainnet.json`. Lookalike issuers are common; never resolve
  an asset by its code alone.
- **Unaudited.** Keep amounts small. Simulate before you sign.
