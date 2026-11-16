# Real-oracle freshness regressions

Two offline tests complement contracts/nav/src/test_mainnet.rs by building
the current NAV contract and advancing time across real-feed expiry boundaries.
They record expected behavior, not a discovered pricing failure.

## Run

Install Rust 1.95.0 with the wasm32v1-none target and Stellar CLI 25.2.0 or newer,
then run from the repository root:

```sh
rustup toolchain install 1.95.0 --profile minimal --target wasm32v1-none
./integration-tests/oracles/check.sh
# After dependencies have been downloaded:
./integration-tests/oracles/check.sh --offline
```

The script builds the current checkout's contracts and replays committed captures.
The CLI builds local WASM; no wallet, deployment or RPC is needed for replay.
The isolated test workspace installs Kanatoko 29.1.1 from crates.io; it does
not change the contracts' SDK dependencies. WASM outputs are ignored, rebuilt in
CI and never used as a substitute for the current source.

## Coverage

- The existing mainnet-test route configuration accepts the primary at max age,
  falls back one second later, accepts the secondary at its limit and returns
  NoFreshPrice after all routes expire.
- A local XLM route with a 27-hour age limit isolates the USDC/USD conversion
  leg's 26-hour expiry: the asset feed is still eligible when conversion expires,
  and a fresh secondary is selected. This configuration variation is explicit.

Real Reflector/RedStone code, prices and feed timestamps are unchanged; only
ledger time and local NAV configuration change. Selected raw feed observations
are asserted unchanged after advancing time.

## Captures

Protocol 29 mainnet captures: primary-expiry.json at ledger 65512112 (timestamp
1794846602), conversion-expiry.json at ledger 65512134 (timestamp 1794846712).
Each has 12 present and 2 confirmed-absent keys and zero final replay RPC reads.
The conversion capture has a 64-second fresh-secondary window; refreshing may
change feed ordering, and explicit preconditions detect that.

Authorization is mocked for local NAV setup. Time advancement does not model
archival, fees or future live feed updates. No deployed NAV is modified.

An explicit refresh can be run after building via cargo test with
KANATOKO_CAPTURE_RPC set to a compatible Protocol 29 endpoint; check.sh clears
that variable. Missing/unknown keys fail closed with no network fallback.
