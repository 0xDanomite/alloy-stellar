# Roadmap

This repository holds Alloy's open-source Soroban contracts. The app that
used to live here is being rebuilt inside the Alloy platform at
[alloy.neevstack.com](https://alloy.neevstack.com); its last version is
preserved at the [`app-final`](https://github.com/0xDanomite/alloy-stellar/tree/app-final/app)
tag.

## Shipped

| Release | What changed |
| --- | --- |
| [v0.1.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.1.0) | Fund and platform contracts: SEP-41 basket shares, in-kind issue, redeem nobody can pause, clawback-safe accounting |
| [v0.2.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.2.0) | Oracle NAV contract: RedStone and Reflector routes, staleness limits, fallback, divergence checks |
| [v0.3.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.3.0) | Manager rebalancing with a per-trade oracle bound |
| [v0.4.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.4.0) | Streaming management fee with a platform share, mandates, rebalance loss budget and cooldown, trades through Soroswap, a timelocked platform admin |
| [v0.5.0](https://github.com/0xDanomite/alloy-stellar/releases/tag/v0.5.0) | Zap: one-transaction USDC deposit into, and cash-out from, any fund |

## Next: hackathon-grade to production-grade

1. **Hardening.** Fuzz and invariant tests over fees, rebalances and the
   zap; mainnet fork tests for every routing path; failure-mode review of
   frozen and clawed-back assets across the zap.
2. **An independent audit** of fund, platform, NAV, timelock and zap.
3. **Routing.** Production swap routing for deposits, cash-outs and
   rebalances, reaching both the Stellar DEX order book and AMM pools.

4. **Issuer primary markets.** Support for settling large deposits and
   withdrawals with an asset's issuer at NAV, where the issuer offers mint
   and redeem, instead of on the order book.

## Later

- **Agent-run funds.** A manager agent with a policy (target weights, drift
  bands, oracle-checked minimums, spend limits) rebalances on its own. The
  manager sets the rules, the agent runs them, and investors can always
  redeem.
- **Fund shares as collateral.** Fund-share NAV as a SEP-40 price feed, so
  shares work across Stellar DeFi.
- **Private investor allowlists,** verified with zero-knowledge proofs.

Contract rules that do not change: `redeem` stays ungated, positions come
from live balances, rounding favors the fund, and contracts are not
upgradeable (new behavior ships as new fund code; existing funds keep
theirs).
