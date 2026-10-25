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
#![no_std]

mod events;
mod storage;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    token::TokenClient, Address, Env, String, Vec,
};

use storage::Config;
pub use storage::{Compliance, Component};

pub const SHARE_DECIMALS: u32 = 7;
pub const SHARE_SCALE: i128 = 10_000_000;
pub const MAX_COMPONENTS: u32 = 12;

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
}

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
    if storage::compliance(env) == Compliance::Allowlist && !storage::is_investor(env, holder) {
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

fn issue_amounts(env: &Env, shares: i128) -> Vec<i128> {
    let supply = storage::supply(env);
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

fn redeem_amounts(env: &Env, shares: i128) -> Vec<i128> {
    let supply = storage::supply(env);
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

    /// Deposit the basket for `shares` from `investor`, minting to `to`.
    /// Returns what was pulled per component, in `components()` order.
    pub fn issue(env: Env, investor: Address, to: Address, shares: i128) -> Vec<i128> {
        investor.require_auth();
        storage::bump_instance(&env);
        require_positive(&env, shares);
        require_can_hold(&env, &to);
        if storage::supply(&env) == 0 {
            credit_leftovers_to_manager(&env);
        }

        let amounts = issue_amounts(&env, shares);
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

        let amounts = redeem_amounts(&env, shares);
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

    pub fn quote_issue(env: Env, shares: i128) -> Vec<i128> {
        require_positive(&env, shares);
        issue_amounts(&env, shares)
    }

    pub fn quote_redeem(env: Env, shares: i128) -> Vec<i128> {
        require_positive(&env, shares);
        redeem_amounts(&env, shares)
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
