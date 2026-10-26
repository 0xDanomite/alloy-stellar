//! Alloy fund: a SEP-41 token whose shares are a basket of Stellar assets.
//!
//! Positions are never stored. Each share is worth `available / supply` of
//! every component, where `available` is the fund's live token balance minus
//! anything owed to past redeemers. A clawback, a freeze or a donation moves
//! the balance and the books follow it automatically. The configured
//! `initial_units` only price the first share, while supply is zero.
//!
//! Redemption has no pause and no manager gate. If one leg cannot be paid
//! (an issuer froze the recipient, say), the redeemer can skip it and claim
//! it later with `withdraw_owed`; the other legs still pay out.
//!
//! `platform()` is whatever the deployer passed in. Whether a fund is genuine
//! is answered by the platform (`is_fund`), never by the fund itself.
//!
//! A streaming management fee, if the manager sets one, is paid by minting
//! new shares, so it dilutes holders continuously and never moves an asset
//! out of the fund. Accrual cannot fail, so it never blocks a redemption.
#![no_std]

mod events;
mod network;
mod storage;

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    token::TokenClient,
    vec, Address, Env, IntoVal, Map, String, Symbol, Vec,
};

pub use storage::{Compliance, Component, FeeState, Mandate, PlatformFee};
use storage::{Config, Loss};

pub const SHARE_DECIMALS: u32 = 7;
pub const SHARE_SCALE: i128 = 10_000_000;
pub const MAX_COMPONENTS: u32 = 12;

const BPS: i128 = 10_000;
pub const YEAR_SECONDS: u64 = 365 * 24 * 60 * 60;
/// Ceiling on the annual management fee: 5%.
pub const MAX_FEE_BPS: u32 = 500;
/// Ceiling on the platform's cut of the management fee: half.
pub const MAX_PLATFORM_SHARE_BPS: u32 = 5_000;

pub const MAX_METADATA_ENTRIES: u32 = 8;
pub const MAX_METADATA_BYTES: u32 = 512;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FundError {
    NoComponents = 1,
    TooManyComponents = 2,
    DuplicateComponent = 3,
    InvalidUnits = 4,
    InvalidAmount = 5,
    InsufficientBalance = 6,
    InsufficientAllowance = 7,
    NotAllowlisted = 8,
    NothingToDeposit = 9,
    UnknownComponent = 10,
    Overflow = 11,
    InvalidExpiration = 12,
    PermissionedComponent = 13,
    ReserveShortfall = 14,
    NoOracle = 15,
    PriceTooLow = 16,
    SameComponent = 17,
    MandateLocked = 18,
    MandateFixed = 19,
    IssuanceOpen = 20,
    FeeAlreadySet = 21,
    FeeTooHigh = 22,
    ShareTooHigh = 23,
    NotOnShelf = 24,
    MetadataTooLarge = 25,
    LossBudgetExceeded = 26,
    RebalanceCooldown = 27,
    BadPrice = 28,
    IssuanceClosed = 29,
    NoRouter = 30,
    InvalidPath = 31,
    SwapShortfall = 32,
    MandateStatic = 33,
}

/// Mirrors `alloy_platform::ShelfStatus`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShelfStatus {
    Unlisted,
    Open,
    Permissioned,
}

#[contractclient(name = "PlatformClient")]
pub trait PlatformInterface {
    fn shelf_status(env: Env, token: Address) -> ShelfStatus;
    fn admin(env: Env) -> Address;
}

/// Mirrors `alloy_nav::PriceQuote`: USD per whole token, 8 decimals.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceQuote {
    pub price: i128,
    pub timestamp: u64,
    pub source: Symbol,
    pub divergence_bps: Option<u32>,
}

#[contractclient(name = "NavClient")]
pub trait NavInterface {
    fn price(env: Env, token: Address) -> PriceQuote;
}

/// The two Soroswap router calls a trade makes. The router pulls `amount_in`
/// of `path[0]` from `to` into the first pair and pays the output to `to`.
#[contractclient(name = "RouterClient")]
pub trait RouterInterface {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
}

/// Longest swap route: the two components and up to two hops between them.
pub const MAX_PATH: u32 = 4;

/// The most value a rebalance may give up against oracle prices: 1%.
pub const MAX_REBALANCE_LOSS_BPS: i128 = 100;
/// The most value all rebalances together may give up against oracle prices
/// within any `LOSS_WINDOW_SECONDS`, as a share of fund value: 2%.
pub const MAX_WINDOW_LOSS_BPS: i128 = 200;
pub const LOSS_WINDOW_SECONDS: u64 = 24 * 60 * 60;
/// A losing rebalance is logged for one window; at most this many may be
/// live at once, so the log has a fixed size.
pub const MAX_WINDOW_LOSSES: u32 = 32;
pub const MIN_REBALANCE_INTERVAL_SECONDS: u64 = 60;
const PPB: i128 = 1_000_000_000;

#[contract]
pub struct Fund;

fn mul_div(env: &Env, a: i128, b: i128, denominator: i128, round_up: bool) -> i128 {
    let product = a
        .checked_mul(b)
        .unwrap_or_else(|| panic_with_error!(env, FundError::Overflow));
    let quotient = product / denominator;
    if round_up && product % denominator != 0 {
        quotient + 1
    } else {
        quotient
    }
}

fn require_positive(env: &Env, amount: i128) {
    if amount <= 0 {
        panic_with_error!(env, FundError::InvalidAmount);
    }
}

fn require_can_hold(env: &Env, holder: &Address) {
    if !can_hold(env, holder) {
        panic_with_error!(env, FundError::NotAllowlisted);
    }
}

fn held(env: &Env, token: &Address) -> i128 {
    TokenClient::new(env, token).balance(&env.current_contract_address())
}

/// What current holders own of `token`. Owed claims rank ahead of holders, so
/// a clawback that cuts below the reserve leaves holders nothing, never less.
fn available(env: &Env, token: &Address) -> i128 {
    (held(env, token) - storage::reserved(env, token)).max(0)
}

fn issue_amounts(env: &Env, shares: i128, supply: i128) -> Vec<i128> {
    let mut amounts = Vec::new(env);
    for component in storage::components(env).iter() {
        // A clawback that cut into owed claims leaves the leg impaired; new
        // money must not paper over it.
        if held(env, &component.token) < storage::reserved(env, &component.token) {
            panic_with_error!(env, FundError::ReserveShortfall);
        }
        let amount = if supply == 0 {
            mul_div(env, component.initial_units, shares, SHARE_SCALE, true)
        } else {
            mul_div(env, available(env, &component.token), shares, supply, true)
        };
        amounts.push_back(amount);
    }
    amounts
}

fn redeem_amounts(env: &Env, shares: i128, supply: i128) -> Vec<i128> {
    let mut amounts = Vec::new(env);
    for component in storage::components(env).iter() {
        let amount = if supply == 0 {
            0
        } else {
            mul_div(env, available(env, &component.token), shares, supply, false)
        };
        amounts.push_back(amount);
    }
    amounts
}

/// Whatever an empty fund still holds (a donation, a pre-seed, shares burned
/// instead of redeemed) is not the next investor's windfall: it becomes an
/// owed claim of the manager, and the first share prices at initial units.
fn credit_leftovers_to_manager(env: &Env) {
    let manager = storage::manager(env);
    for component in storage::components(env).iter() {
        let leftover = available(env, &component.token);
        if leftover > 0 {
            storage::set_owed(
                env,
                &manager,
                &component.token,
                storage::owed(env, &manager, &component.token) + leftover,
            );
            storage::set_reserved(
                env,
                &component.token,
                storage::reserved(env, &component.token) + leftover,
            );
            events::LeftoverCredited {
                manager: manager.clone(),
                token: component.token.clone(),
                amount: leftover,
            }
            .publish(env);
        }
    }
}

fn mint(env: &Env, to: &Address, shares: i128) {
    storage::set_balance(env, to, storage::balance(env, to) + shares);
    storage::set_supply(env, storage::supply(env) + shares);
    events::Mint {
        to: to.clone(),
        amount: shares,
    }
    .publish(env);
}

fn burn_shares(env: &Env, from: &Address, shares: i128) {
    let balance = storage::balance(env, from);
    if balance < shares {
        panic_with_error!(env, FundError::InsufficientBalance);
    }
    storage::set_balance(env, from, balance - shares);
    storage::set_supply(env, storage::supply(env) - shares);
    events::Burn {
        from: from.clone(),
        amount: shares,
    }
    .publish(env);
}

fn move_shares(env: &Env, from: &Address, to: &Address, shares: i128) {
    require_positive(env, shares);
    require_can_hold(env, to);
    let balance = storage::balance(env, from);
    if balance < shares {
        panic_with_error!(env, FundError::InsufficientBalance);
    }
    storage::set_balance(env, from, balance - shares);
    storage::set_balance(env, to, storage::balance(env, to) + shares);
    events::Transfer {
        from: from.clone(),
        to: to.clone(),
        amount: shares,
    }
    .publish(env);
}

fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
    let allowance = storage::allowance(env, from, spender);
    if allowance.amount < amount {
        panic_with_error!(env, FundError::InsufficientAllowance);
    }
    storage::set_allowance(
        env,
        from,
        spender,
        allowance.amount - amount,
        allowance.expiration_ledger,
    );
}

/// Shares that pay the fee for `elapsed` seconds at `rate_bps` a year, sized
/// so that after minting they own exactly that fraction of the fund:
/// `supply * f / (1 - f)` with `f = rate * elapsed / year`. Elapsed time is
/// capped at one year per accrual, which keeps `f` below one. An overflow
/// mints nothing rather than fail, so accrual can never block a redemption.
fn fee_shares(supply: i128, rate_bps: u32, elapsed: u64) -> i128 {
    let accrued = i128::from(rate_bps) * i128::from(elapsed.min(YEAR_SECONDS));
    let whole = BPS * i128::from(YEAR_SECONDS);
    supply
        .checked_mul(accrued)
        .map_or(0, |numerator| numerator / (whole - accrued))
}

fn pending_fee_shares(env: &Env) -> i128 {
    match storage::fee(env) {
        Some(fee) => fee_shares(
            storage::supply(env),
            fee.rate_bps,
            env.ledger().timestamp().saturating_sub(fee.last_accrual),
        ),
        None => 0,
    }
}

fn accrue_fee(env: &Env) -> i128 {
    let Some(mut fee) = storage::fee(env) else {
        return 0;
    };
    let now = env.ledger().timestamp();
    if now <= fee.last_accrual {
        return 0;
    }
    let minted = fee_shares(storage::supply(env), fee.rate_bps, now - fee.last_accrual);
    fee.last_accrual = now;
    storage::set_fee(env, &fee);
    if minted == 0 {
        return 0;
    }

    let platform = storage::platform_fee(env);
    let platform_shares = platform.as_ref().map_or(0, |cut| {
        minted
            .checked_mul(i128::from(cut.share_bps))
            .map_or(0, |product| product / BPS)
    });
    let recipient = storage::fee_recipient(env);
    let manager_shares = minted - platform_shares;
    pay_fee(env, &recipient, manager_shares);
    let platform_recipient = platform.map(|cut| cut.recipient);
    if let Some(to) = &platform_recipient {
        pay_fee(env, to, platform_shares);
    }
    events::FeeAccrued {
        recipient,
        shares: manager_shares,
        platform_recipient,
        platform_shares,
    }
    .publish(env);
    minted
}

fn can_hold(env: &Env, holder: &Address) -> bool {
    storage::compliance(env) == Compliance::Open || storage::is_investor(env, holder)
}

/// Fee shares go to a recipient only if it could hold them as an investor.
/// Otherwise the fund mints them to itself and keeps them in escrow for that
/// recipient until `claim_fee`, so dilution stays exact and no share ever
/// lands outside the allowlist.
fn pay_fee(env: &Env, to: &Address, shares: i128) {
    if shares <= 0 {
        return;
    }
    if can_hold(env, to) {
        mint(env, to, shares);
    } else {
        mint(env, &env.current_contract_address(), shares);
        storage::set_fee_escrow(env, to, storage::fee_escrow(env, to) + shares);
    }
}

/// Fee terms and mandate are settled before anyone can buy in, so nobody
/// can issue first and lock the manager out of them.
fn require_not_open(env: &Env) {
    if storage::is_open(env) {
        panic_with_error!(env, FundError::IssuanceOpen);
    }
}

fn mandate(env: &Env) -> Mandate {
    storage::mandate(env).unwrap_or(Mandate::Locked)
}

fn nav_address(env: &Env) -> Option<Address> {
    storage::nav(env).or_else(|| network::DEFAULT_NAV.map(|id| Address::from_str(env, id)))
}

fn router_address(env: &Env) -> Option<Address> {
    storage::router(env).or_else(|| network::DEFAULT_ROUTER.map(|id| Address::from_str(env, id)))
}

fn oracle_price(env: &Env, oracle: &NavClient, token: &Address) -> i128 {
    let price = oracle.price(token).price;
    if price <= 0 {
        panic_with_error!(env, FundError::BadPrice);
    }
    price
}

fn usd_value(env: &Env, amount: i128, price: i128, round_up: bool) -> i128 {
    mul_div(env, amount, price, SHARE_SCALE, round_up)
}

/// What the fund's holdings are worth at oracle prices, in USD with the
/// oracle's 8 decimals. Legs the fund holds none of need no price.
fn fund_value(env: &Env, oracle: &NavClient) -> i128 {
    let mut total: i128 = 0;
    for component in storage::components(env).iter() {
        let amount = available(env, &component.token);
        if amount > 0 {
            let price = oracle_price(env, oracle, &component.token);
            total = total
                .checked_add(usd_value(env, amount, price, false))
                .unwrap_or_else(|| panic_with_error!(env, FundError::Overflow));
        }
    }
    total
}

/// The checks every manager trade shares: a mandate that trades (`Locked` or
/// `Managed`), two distinct components, enough of the sold one, the
/// cooldown, and an oracle.
fn begin_trade(env: &Env, sell: &Address, sold: i128, buy: &Address) -> NavClient<'static> {
    if mandate(env) == Mandate::Static {
        panic_with_error!(env, FundError::MandateStatic);
    }
    require_positive(env, sold);
    if sell == buy {
        panic_with_error!(env, FundError::SameComponent);
    }
    let components = storage::components(env);
    for token in [sell, buy] {
        if !components.iter().any(|c| &c.token == token) {
            panic_with_error!(env, FundError::UnknownComponent);
        }
    }
    if sold > available(env, sell) {
        panic_with_error!(env, FundError::InsufficientBalance);
    }
    if let Some(last) = storage::last_rebalance(env) {
        if env.ledger().timestamp() < last.saturating_add(MIN_REBALANCE_INTERVAL_SECONDS) {
            panic_with_error!(env, FundError::RebalanceCooldown);
        }
    }
    let nav = nav_address(env).unwrap_or_else(|| panic_with_error!(env, FundError::NoOracle));
    NavClient::new(env, &nav)
}

fn live_losses(env: &Env) -> (Vec<Loss>, i128) {
    let now = env.ledger().timestamp();
    let mut live = Vec::new(env);
    let mut used = 0;
    for loss in storage::losses(env).iter() {
        if loss.at.saturating_add(LOSS_WINDOW_SECONDS) > now {
            used += loss.ppb;
            live.push_back(loss);
        }
    }
    (live, used)
}

/// Charges what a trade gave up against oracle prices to the rolling loss
/// budget, refusing the trade if the window's total would pass
/// `MAX_WINDOW_LOSS_BPS` of fund value, and starts the cooldown.
fn settle_trade(env: &Env, fund_value: i128, value_out: i128, value_in: i128) {
    let (mut live, used) = live_losses(env);
    let lost = value_out - value_in;
    if lost > 0 {
        let ppb = if fund_value > 0 {
            mul_div(env, lost, PPB, fund_value, true)
        } else {
            PPB
        };
        if used + ppb > MAX_WINDOW_LOSS_BPS * (PPB / BPS) || live.len() >= MAX_WINDOW_LOSSES {
            panic_with_error!(env, FundError::LossBudgetExceeded);
        }
        live.push_back(Loss {
            at: env.ledger().timestamp(),
            ppb,
        });
    }
    storage::set_losses(env, &live);
    storage::set_last_rebalance(env, env.ledger().timestamp());
}

#[contractimpl]
impl Fund {
    pub fn __constructor(
        env: Env,
        platform: Address,
        manager: Address,
        name: String,
        symbol: String,
        components: Vec<Component>,
        compliance: Compliance,
    ) {
        if components.is_empty() {
            panic_with_error!(&env, FundError::NoComponents);
        }
        if components.len() > MAX_COMPONENTS {
            panic_with_error!(&env, FundError::TooManyComponents);
        }
        for (i, component) in components.iter().enumerate() {
            if component.initial_units <= 0 {
                panic_with_error!(&env, FundError::InvalidUnits);
            }
            for other in components.iter().skip(i + 1) {
                if other.token == component.token {
                    panic_with_error!(&env, FundError::DuplicateComponent);
                }
            }
        }
        storage::write_config(
            &env,
            &Config {
                platform,
                manager,
                name,
                symbol,
                components,
                compliance,
            },
        );
        storage::bump_instance(&env);
    }

    /// Ends the fund's setup: after this, anyone allowed may `issue`, and the
    /// fee and mandate can no longer be set. Manager only, once.
    pub fn open_for_issue(env: Env) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        require_not_open(&env);
        storage::set_open(&env);
        events::IssuanceOpened {}.publish(&env);
    }

    pub fn is_open(env: Env) -> bool {
        storage::is_open(&env)
    }

    /// Deposit the basket for `shares` from `investor`, minting to `to`.
    /// Returns what was pulled per component, in `components()` order.
    /// Refused until the manager has called `open_for_issue`.
    pub fn issue(env: Env, investor: Address, to: Address, shares: i128) -> Vec<i128> {
        investor.require_auth();
        storage::bump_instance(&env);
        if !storage::is_open(&env) {
            panic_with_error!(&env, FundError::IssuanceClosed);
        }
        require_positive(&env, shares);
        require_can_hold(&env, &to);
        accrue_fee(&env);
        let supply = storage::supply(&env);
        if supply == 0 {
            credit_leftovers_to_manager(&env);
        }

        let amounts = issue_amounts(&env, shares, supply);
        if amounts.iter().all(|amount| amount == 0) {
            panic_with_error!(&env, FundError::NothingToDeposit);
        }
        let fund = env.current_contract_address();
        for (component, amount) in storage::components(&env).iter().zip(amounts.iter()) {
            if amount > 0 {
                TokenClient::new(&env, &component.token).transfer(&investor, &fund, &amount);
            }
        }
        mint(&env, &to, shares);
        events::Issue {
            investor,
            to,
            shares,
            amounts: amounts.clone(),
        }
        .publish(&env);
        amounts
    }

    /// Burn `shares` from `from` and pay the pro-rata basket to `to`.
    /// Legs listed in `skip` are booked as owed to `from` instead of paid.
    /// Nobody, manager included, can stop this call.
    pub fn redeem(
        env: Env,
        from: Address,
        to: Address,
        shares: i128,
        skip: Vec<Address>,
    ) -> Vec<i128> {
        from.require_auth();
        storage::bump_instance(&env);
        require_positive(&env, shares);

        let components = storage::components(&env);
        for token in skip.iter() {
            if !components.iter().any(|component| component.token == token) {
                panic_with_error!(&env, FundError::UnknownComponent);
            }
        }

        accrue_fee(&env);
        let amounts = redeem_amounts(&env, shares, storage::supply(&env));
        burn_shares(&env, &from, shares);

        let fund = env.current_contract_address();
        for (component, amount) in components.iter().zip(amounts.iter()) {
            if amount == 0 {
                continue;
            }
            if skip.contains(&component.token) {
                storage::set_owed(
                    &env,
                    &from,
                    &component.token,
                    storage::owed(&env, &from, &component.token) + amount,
                );
                storage::set_reserved(
                    &env,
                    &component.token,
                    storage::reserved(&env, &component.token) + amount,
                );
            } else {
                TokenClient::new(&env, &component.token).transfer(&fund, &to, &amount);
            }
        }
        events::Redeem {
            from,
            to,
            shares,
            amounts: amounts.clone(),
            skip,
        }
        .publish(&env);
        amounts
    }

    /// Pay out a leg that an earlier redeem skipped.
    pub fn withdraw_owed(env: Env, owner: Address, to: Address, token: Address) -> i128 {
        owner.require_auth();
        storage::bump_instance(&env);
        let owed = storage::owed(&env, &owner, &token);
        require_positive(&env, owed);
        // After a deep clawback the fund may hold less than it owes; pay what
        // is there and leave the rest owed.
        let amount = owed.min(held(&env, &token));
        require_positive(&env, amount);
        storage::set_owed(&env, &owner, &token, owed - amount);
        storage::set_reserved(&env, &token, storage::reserved(&env, &token) - amount);
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
        events::WithdrawOwed {
            owner,
            to,
            token,
            amount,
        }
        .publish(&env);
        amount
    }

    /// Quotes include the management fee that would accrue first.
    pub fn quote_issue(env: Env, shares: i128) -> Vec<i128> {
        require_positive(&env, shares);
        let supply = storage::supply(&env) + pending_fee_shares(&env);
        issue_amounts(&env, shares, supply)
    }

    pub fn quote_redeem(env: Env, shares: i128) -> Vec<i128> {
        require_positive(&env, shares);
        let supply = storage::supply(&env) + pending_fee_shares(&env);
        redeem_amounts(&env, shares, supply)
    }

    pub fn components(env: Env) -> Vec<Component> {
        storage::components(&env)
    }

    /// Live holdings per component, net of amounts owed to past redeemers.
    pub fn holdings(env: Env) -> Vec<i128> {
        let mut holdings = Vec::new(&env);
        for component in storage::components(&env).iter() {
            holdings.push_back(available(&env, &component.token));
        }
        holdings
    }

    /// Amount of each component backing one whole share (10^7 units).
    pub fn units_per_share(env: Env) -> Vec<i128> {
        let supply = storage::supply(&env);
        let mut units = Vec::new(&env);
        for component in storage::components(&env).iter() {
            let unit = if supply == 0 {
                component.initial_units
            } else {
                mul_div(
                    &env,
                    available(&env, &component.token),
                    SHARE_SCALE,
                    supply,
                    false,
                )
            };
            units.push_back(unit);
        }
        units
    }

    pub fn owed(env: Env, owner: Address, token: Address) -> i128 {
        storage::owed(&env, &owner, &token)
    }

    pub fn total_supply(env: Env) -> i128 {
        storage::supply(&env)
    }

    pub fn platform(env: Env) -> Address {
        storage::platform(&env)
    }

    pub fn manager(env: Env) -> Address {
        storage::manager(&env)
    }

    pub fn compliance(env: Env) -> Compliance {
        storage::compliance(&env)
    }

    pub fn is_investor(env: Env, investor: Address) -> bool {
        storage::is_investor(&env, &investor)
    }

    pub fn set_investor(env: Env, investor: Address, allowed: bool) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        storage::set_investor(&env, &investor, allowed);
        events::InvestorSet { investor, allowed }.publish(&env);
    }

    /// Opening the fund to anyone needs every component classed exactly
    /// `Open` on the platform shelf; permissioned or delisted legs keep the
    /// allowlist on.
    pub fn set_compliance(env: Env, compliance: Compliance) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        if compliance == Compliance::Open {
            let platform = PlatformClient::new(&env, &storage::platform(&env));
            for component in storage::components(&env).iter() {
                if platform.shelf_status(&component.token) != ShelfStatus::Open {
                    panic_with_error!(&env, FundError::PermissionedComponent);
                }
            }
        }
        storage::set_compliance(&env, compliance);
        events::ComplianceSet { compliance }.publish(&env);
    }

    /// The oracle that bounds rebalances. Only the platform admin sets it,
    /// so a manager can't point the fund at prices they control.
    pub fn set_nav(env: Env, nav: Address) {
        PlatformClient::new(&env, &storage::platform(&env))
            .admin()
            .require_auth();
        storage::bump_instance(&env);
        storage::set_nav(&env, &nav);
        events::NavSet { nav }.publish(&env);
    }

    /// The oracle bounding rebalances: the one the platform admin set, else
    /// the network default compiled into this build, else none.
    pub fn nav(env: Env) -> Option<Address> {
        nav_address(&env)
    }

    /// The manager swaps `sold` of one component for `bought` of another:
    /// the fund pays out `sell` and takes in `buy` in the same transaction.
    /// Shares re-weight through the balances. Each trade must be worth at
    /// least 99% of what leaves the fund at oracle prices, everything given
    /// up within a rolling day must stay under 2% of fund value, and trades
    /// are at least a minute apart, so a manager or agent can't drain value
    /// through bad fills, one at a time or in a burst. `Locked` and `Managed`
    /// funds rebalance among existing components; `Static` funds never do. Where the manager sources the
    /// bought asset (SDEX, Soroswap, an RFQ desk) is up to them.
    pub fn rebalance(env: Env, sell: Address, sold: i128, buy: Address, bought: i128) {
        let manager = storage::manager(&env);
        manager.require_auth();
        storage::bump_instance(&env);
        require_positive(&env, bought);
        let oracle = begin_trade(&env, &sell, sold, &buy);

        let value_out = usd_value(&env, sold, oracle_price(&env, &oracle, &sell), true);
        let value_in = usd_value(&env, bought, oracle_price(&env, &oracle, &buy), false);
        let floor = mul_div(&env, value_out, BPS - MAX_REBALANCE_LOSS_BPS, BPS, true);
        if value_in < floor {
            panic_with_error!(&env, FundError::PriceTooLow);
        }
        settle_trade(&env, fund_value(&env, &oracle), value_out, value_in);

        let fund = env.current_contract_address();
        TokenClient::new(&env, &buy).transfer(&manager, &fund, &bought);
        TokenClient::new(&env, &sell).transfer(&fund, &manager, &sold);
        events::Rebalanced {
            manager,
            sell,
            sold,
            buy,
            bought,
        }
        .publish(&env);
    }

    /// The manager sells `sold` of one component for another through the
    /// Soroswap router along `path` (`sell`, any hops, `buy`), with the fund
    /// itself as the trader: assets never pass through the manager. The fund
    /// authorizes exactly one transfer, `sold` of `sell` into the route's
    /// first pair, and demands at least the larger of `min_bought` and 99%
    /// of `sold` at oracle prices. The result counts toward the same loss
    /// budget and cooldown as `rebalance`, and a `Static` fund refuses it.
    /// Returns the amount bought.
    pub fn trade(
        env: Env,
        sell: Address,
        sold: i128,
        buy: Address,
        min_bought: i128,
        path: Vec<Address>,
    ) -> i128 {
        let manager = storage::manager(&env);
        manager.require_auth();
        storage::bump_instance(&env);
        if min_bought < 0 {
            panic_with_error!(&env, FundError::InvalidAmount);
        }
        let oracle = begin_trade(&env, &sell, sold, &buy);
        if path.len() < 2
            || path.len() > MAX_PATH
            || path.first_unchecked() != sell
            || path.last_unchecked() != buy
        {
            panic_with_error!(&env, FundError::InvalidPath);
        }
        let router =
            router_address(&env).unwrap_or_else(|| panic_with_error!(&env, FundError::NoRouter));

        let buy_price = oracle_price(&env, &oracle, &buy);
        let value_out = usd_value(&env, sold, oracle_price(&env, &oracle, &sell), true);
        let floor = mul_div(&env, value_out, BPS - MAX_REBALANCE_LOSS_BPS, BPS, true);
        let min_out = mul_div(&env, floor, SHARE_SCALE, buy_price, true).max(min_bought);
        let value_before = fund_value(&env, &oracle);

        let fund = env.current_contract_address();
        let router_client = RouterClient::new(&env, &router);
        let pair = router_client.router_pair_for(&sell, &path.get_unchecked(1));
        let sell_before = held(&env, &sell);
        let buy_before = held(&env, &buy);
        // Covers only the next call this contract makes: the swap below.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: sell.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (fund.clone(), pair, sold).into_val(&env),
                },
                sub_invocations: Vec::new(&env),
            }),
        ]);
        router_client.swap_exact_tokens_for_tokens(
            &sold,
            &min_out,
            &path,
            &fund,
            &(env.ledger().timestamp() + 1),
        );
        // Balances, not the router's report, decide what the fund got.
        let bought = held(&env, &buy) - buy_before;
        if bought < min_out || sell_before - held(&env, &sell) > sold {
            panic_with_error!(&env, FundError::SwapShortfall);
        }
        let value_in = usd_value(&env, bought, buy_price, false);
        settle_trade(&env, value_before, value_out, value_in);

        events::Traded {
            manager,
            router,
            sell,
            sold,
            buy,
            bought,
            min_bought: min_out,
        }
        .publish(&env);
        bought
    }

    /// The DEX router `trade` uses. Only the platform admin sets it, like the
    /// oracle, so a manager can't route the fund's assets through a contract
    /// they control.
    pub fn set_router(env: Env, router: Address) {
        PlatformClient::new(&env, &storage::platform(&env))
            .admin()
            .require_auth();
        storage::bump_instance(&env);
        storage::set_router(&env, &router);
        events::RouterSet { router }.publish(&env);
    }

    /// The admin-set router, else the network default compiled into this
    /// build, else none.
    pub fn router(env: Env) -> Option<Address> {
        router_address(&env)
    }

    /// What rebalances have given up against oracle prices inside the
    /// current window, in parts per billion of fund value (1 bps = 100_000).
    pub fn window_loss_ppb(env: Env) -> i128 {
        live_losses(&env).1
    }

    pub fn last_rebalance(env: Env) -> Option<u64> {
        storage::last_rebalance(&env)
    }

    pub fn mandate(env: Env) -> Mandate {
        mandate(&env)
    }

    /// Commits the fund to `Locked`, `Managed` or `Static`. Allowed once, before
    /// `open_for_issue`, so holders always know which one they bought.
    /// A fund that never chooses is `Locked`.
    pub fn set_mandate(env: Env, mandate: Mandate) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        if storage::mandate(&env).is_some() {
            panic_with_error!(&env, FundError::MandateFixed);
        }
        require_not_open(&env);
        storage::set_mandate(&env, mandate);
        events::MandateSet { mandate }.publish(&env);
    }

    /// Adds a shelf asset to a `Managed` fund. It starts at zero units and
    /// gains weight only through rebalances. A permissioned asset needs the
    /// fund's investor allowlist on, as at creation.
    pub fn add_component(env: Env, token: Address) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        match mandate(&env) {
            Mandate::Managed => {}
            Mandate::Locked => panic_with_error!(&env, FundError::MandateLocked),
            Mandate::Static => panic_with_error!(&env, FundError::MandateStatic),
        }
        let mut components = storage::components(&env);
        if components.len() >= MAX_COMPONENTS {
            panic_with_error!(&env, FundError::TooManyComponents);
        }
        if components.iter().any(|c| c.token == token) {
            panic_with_error!(&env, FundError::DuplicateComponent);
        }
        match PlatformClient::new(&env, &storage::platform(&env)).shelf_status(&token) {
            ShelfStatus::Unlisted => panic_with_error!(&env, FundError::NotOnShelf),
            ShelfStatus::Permissioned if storage::compliance(&env) != Compliance::Allowlist => {
                panic_with_error!(&env, FundError::PermissionedComponent)
            }
            _ => {}
        }
        components.push_back(Component {
            token: token.clone(),
            initial_units: 0,
        });
        storage::set_components(&env, &components);
        events::ComponentAdded { token }.publish(&env);
    }

    /// Sets the annual management fee, once, before `open_for_issue`.
    /// Zero is a valid, permanent choice. The fee streams from this moment.
    pub fn init_fee(env: Env, rate_bps: u32) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        if storage::fee(&env).is_some() {
            panic_with_error!(&env, FundError::FeeAlreadySet);
        }
        if rate_bps > MAX_FEE_BPS {
            panic_with_error!(&env, FundError::FeeTooHigh);
        }
        require_not_open(&env);
        storage::set_fee(
            &env,
            &FeeState {
                rate_bps,
                last_accrual: env.ledger().timestamp(),
            },
        );
        events::FeeInitialized { rate_bps }.publish(&env);
    }

    /// Mints the management fee accrued since the last call. Anyone may call
    /// it; `issue` and `redeem` call it first. Returns the shares minted.
    pub fn accrue_fee(env: Env) -> i128 {
        storage::bump_instance(&env);
        accrue_fee(&env)
    }

    /// Fee shares that `accrue_fee` would mint now.
    pub fn pending_fee(env: Env) -> i128 {
        pending_fee_shares(&env)
    }

    /// Fee shares held for `recipient` because it could not hold shares
    /// when they accrued (off the allowlist of an `Allowlist` fund).
    pub fn fee_escrow(env: Env, recipient: Address) -> i128 {
        storage::fee_escrow(&env, &recipient)
    }

    /// Releases `recipient`'s escrowed fee shares once it may hold them.
    /// Anyone may call it; the shares only ever go to `recipient`.
    pub fn claim_fee(env: Env, recipient: Address) -> i128 {
        storage::bump_instance(&env);
        let shares = storage::fee_escrow(&env, &recipient);
        move_shares(&env, &env.current_contract_address(), &recipient, shares);
        storage::set_fee_escrow(&env, &recipient, 0);
        shares
    }

    pub fn fee(env: Env) -> Option<FeeState> {
        storage::fee(&env)
    }

    /// Where the manager's part of the fee is minted; the manager by default.
    pub fn fee_recipient(env: Env) -> Address {
        storage::fee_recipient(&env)
    }

    pub fn set_fee_recipient(env: Env, recipient: Address) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        require_can_hold(&env, &recipient);
        accrue_fee(&env);
        storage::set_fee_recipient(&env, &recipient);
        events::FeeRecipientSet { recipient }.publish(&env);
    }

    pub fn platform_fee(env: Env) -> Option<PlatformFee> {
        storage::platform_fee(&env)
    }

    /// The platform's cut of this fund's management fee, set by the platform
    /// admin and capped at half. It splits the fee; it never raises it.
    pub fn set_platform_fee(env: Env, share_bps: u32, recipient: Address) {
        PlatformClient::new(&env, &storage::platform(&env))
            .admin()
            .require_auth();
        storage::bump_instance(&env);
        if share_bps > MAX_PLATFORM_SHARE_BPS {
            panic_with_error!(&env, FundError::ShareTooHigh);
        }
        require_can_hold(&env, &recipient);
        accrue_fee(&env);
        storage::set_platform_fee(
            &env,
            &PlatformFee {
                share_bps,
                recipient: recipient.clone(),
            },
        );
        events::PlatformFeeSet {
            recipient,
            share_bps,
        }
        .publish(&env);
    }

    /// Manager-written descriptive fields (`description`, `strategy`,
    /// `website`, ...). An empty value removes the key.
    pub fn set_metadata(env: Env, key: Symbol, value: String) {
        storage::manager(&env).require_auth();
        storage::bump_instance(&env);
        if value.len() > MAX_METADATA_BYTES {
            panic_with_error!(&env, FundError::MetadataTooLarge);
        }
        let mut map = storage::metadata(&env);
        if value.is_empty() {
            map.remove(key.clone());
        } else {
            map.set(key.clone(), value.clone());
            if map.len() > MAX_METADATA_ENTRIES {
                panic_with_error!(&env, FundError::MetadataTooLarge);
            }
        }
        storage::set_metadata(&env, &map);
        events::MetadataSet { key, value }.publish(&env);
    }

    pub fn metadata(env: Env) -> Map<Symbol, String> {
        storage::metadata(&env)
    }

    pub fn set_manager(env: Env, new_manager: Address) {
        let manager = storage::manager(&env);
        manager.require_auth();
        new_manager.require_auth();
        storage::bump_instance(&env);
        storage::set_manager(&env, &new_manager);
        events::ManagerSet {
            previous: manager,
            manager: new_manager,
        }
        .publish(&env);
    }

    // SEP-41

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        storage::allowance(&env, &from, &spender).amount
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        storage::bump_instance(&env);
        if amount < 0 {
            panic_with_error!(&env, FundError::InvalidAmount);
        }
        let sequence = env.ledger().sequence();
        if amount > 0
            && (expiration_ledger < sequence
                || expiration_ledger > sequence + env.storage().max_ttl())
        {
            panic_with_error!(&env, FundError::InvalidExpiration);
        }
        storage::set_allowance(&env, &from, &spender, amount, expiration_ledger);
        events::Approve {
            from,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        storage::balance(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        storage::bump_instance(&env);
        move_shares(&env, &from, &to, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        storage::bump_instance(&env);
        spend_allowance(&env, &from, &spender, amount);
        move_shares(&env, &from, &to, amount);
    }

    /// Destroys shares without redeeming; the basket stays with the other holders.
    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        storage::bump_instance(&env);
        require_positive(&env, amount);
        burn_shares(&env, &from, amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        storage::bump_instance(&env);
        require_positive(&env, amount);
        spend_allowance(&env, &from, &spender, amount);
        burn_shares(&env, &from, amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        SHARE_DECIMALS
    }

    pub fn name(env: Env) -> String {
        storage::name(&env)
    }

    pub fn symbol(env: Env) -> String {
        storage::symbol(&env)
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_reference_model;
