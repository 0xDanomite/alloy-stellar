# Alloy on Stellar

Multi-asset fund tokens for wealth managers, built from Stellar's tokenized
treasuries, stablecoins and permissioned funds, with redemption no manager
can switch off.

> Work in progress at HackMeridian 2026 (Lisbon, 25 to 26 October).
> This README is filled in as the build lands; the `arrival` tag marks the
> state we walked in with.

## What We Started With

**Alloy is live in production on two EVM chains. None of it ran on Stellar.**

- App: [alloy.neevstack.com](https://alloy.neevstack.com), our own
  timelocked multi-asset fund protocol on Robinhood Chain
  (4663) and Polygon (137): fund creator, mandate manager, fee splitter,
  Chainlink and Pyth oracle adapters, a zap, a manager console and an
  investor app.
- The EVM codebase is private. This repository is new, public, and
  everything in it was written at HackMeridian.

## How It Works

[docs/how-it-works.md](docs/how-it-works.md): the accounting, the guarantees and
the tests that hold them, issuer rails, and verifiable builds.

## License

[Apache-2.0](LICENSE)
