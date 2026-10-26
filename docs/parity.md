# Parity with Alloy on EVM

Alloy on Stellar has Alloy's fund core today. The rest of the EVM product is being ported in two
steps: everything that runs onchain first, then the parts that need the hosted Alloy API.

## Already on Stellar

- Basket fund token: in-kind issue and redeem, units from live balances, redemption that cannot
  be paused, frozen legs booked as owed claims.
- Gated factory: manager allowlist and an approved-asset shelf, with permissioned assets forcing
  an investor allowlist.
- Oracle NAV from Reflector and RedStone with staleness, fallback and divergence checks.
- Manager rebalance bounded by oracle prices.
- Issuer rails (authorization and clawback) that EVM Alloy does not have.

## Coming next, onchain

| Area | What lands |
| --- | --- |
| Fees | Streaming management fee frozen at creation, platform share up to 50% |
| Governance | Timelocked admin for the platform and NAV contracts |
| Trading | Rebalance through Soroswap from inside the fund, with an oracle floor, loss budget and cooldown |
| Mandates | Locked or managed asset universe; fund metadata |
| Fund page | NAV chart with ranges and returns, 24h change, allocation donut, NAV proof, activity feed, trust panel |
| Portfolio | Held and managed funds, owed claims, needs-attention alerts |
| Managers | Target-weight rebalance planner, earnings, profile, management transfer, multi-step fund creation |
| Admin | Console for managers, shelf, oracle routes and the timelock queue |
| Wallets | WalletConnect for mobile wallets |

## Later, with the hosted API

Recorded NAV history, liquidity analytics, email login with roles, and wallet linking.
