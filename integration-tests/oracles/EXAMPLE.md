# When does NAV switch price feeds?

The existing mainnet snapshot test reads prices at a single timestamp. These two tests use [Kanatoko](https://crates.io/crates/kanatoko) to run the current NAV contract against captured Reflector and RedStone feeds while moving the clock across each expiry.

| Clock or route condition | Price source returned by NAV |
| --- | --- |
| Primary price reaches its maximum age | Reflector |
| One second later | RedStone |
| Secondary reaches its maximum age, then ages one more second | RedStone at the limit, then `NoFreshPrice` |
| USDC/USD conversion expires while XLM is still fresh | RedStone for XLM |

The conversion test sets the local XLM age limit to 27 hours so the 26-hour conversion limit expires first. Both tests check that the recorded oracle observations stay fixed. Protocol 29 mainnet ledgers 65512112 and 65512134 are in [fixtures](fixtures/).

[Read the Rust assertions](tests/oracles.rs#L98).

## Reproduce locally

Use Rust 1.95.0 with the `wasm32v1-none` target and Stellar CLI (verified with 27.0.0). From the repo root, build the contracts, fetch the locked test dependencies once, then run the test offline.

```sh
RUSTUP_TOOLCHAIN=1.95.0 stellar contract build --locked --package alloy-nav --out-dir integration-tests/oracles/wasm
cargo +1.95.0 fetch --locked --manifest-path integration-tests/oracles/Cargo.toml
cargo +1.95.0 test --locked --offline --manifest-path integration-tests/oracles/Cargo.toml
```
