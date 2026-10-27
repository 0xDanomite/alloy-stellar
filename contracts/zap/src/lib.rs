//! Alloy zap: buy into or cash out of any Alloy fund with USDC in one
//! transaction, through the Soroswap router.
//!
//! `issue_with_usdc` takes up to `max_usdc` from the investor, buys exactly
//! the basket `quote_issue` asks for, issues the shares to the investor with
//! the zap as the depositor, and refunds what it did not spend.
//! `redeem_to_usdc` redeems the owner's shares to the zap, sells every leg
//! for USDC and pays the owner, or reverts under `min_usdc`.
//!
//! The zap is stateless and permissionless. It keeps only its router, USDC
//! and trusted platform addresses, serves only funds one of those platforms
//! created (`is_fund`), measures every leg by balance change, and refuses
//! any call that would end with the zap holding anything other than what it
//! held before. Tokens sent to the zap by mistake stay there; no call can
//! spend them. The investor's or owner's signature is the only one either
//! call needs: the zap authorizes its own token movements one exact
//! transfer at a time.
#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error,
    token::TokenClient,
    vec, Address, Env, IntoVal, Symbol, Vec,
};

/// Longest swap route: USDC, the leg token and up to two hops between them.
pub const MAX_PATH: u32 = 4;
pub const MAX_PLATFORMS: u32 = 8;

const DAY_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const INSTANCE_BUMP_TO: u32 = 120 * DAY_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ZapError {
    InvalidPath = 1,
    SlippageExceeded = 2,
    InvalidAmount = 3,
    MissingPath = 4,
    Overflow = 5,
    UnknownFund = 6,
    DuplicateComponent = 7,
    InvalidPlatforms = 8,
    HoldingsChanged = 9,
}

/// Mirrors `alloy_fund::Component`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub token: Address,
    pub initial_units: i128,
}

#[contractclient(name = "FundClient")]
pub trait FundInterface {
    fn components(env: Env) -> Vec<Component>;
    fn quote_issue(env: Env, shares: i128) -> Vec<i128>;
    fn issue(env: Env, investor: Address, to: Address, shares: i128) -> Vec<i128>;
    fn redeem(env: Env, from: Address, to: Address, shares: i128, skip: Vec<Address>) -> Vec<i128>;
}

#[contractclient(name = "PlatformClient")]
pub trait PlatformInterface {
    fn is_fund(env: Env, fund: Address) -> bool;
}

/// The Soroswap router calls the zap makes. Both swaps require `to`'s auth
/// and pull `amounts[0]` of `path[0]` from `to` into the first pair.
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
    fn swap_tokens_for_exact_tokens(
        env: Env,
        amount_out: i128,
        amount_in_max: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
    fn router_get_amounts_in(env: Env, amount_out: i128, path: Vec<Address>) -> Vec<i128>;
    fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128>;
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Router,
    Usdc,
    Platforms,
}

#[contractevent(topics = ["zap_issue"])]
pub struct ZapIssue {
    #[topic]
    pub investor: Address,
    #[topic]
    pub fund: Address,
    pub shares: i128,
    pub usdc_spent: i128,
}

#[contractevent(topics = ["zap_redeem"])]
pub struct ZapRedeem {
    #[topic]
    pub owner: Address,
    #[topic]
    pub fund: Address,
    pub shares: i128,
    pub usdc_out: i128,
}

#[contract]
pub struct Zap;

struct Venue<'a> {
    zap: Address,
    usdc: TokenClient<'a>,
    router: RouterClient<'a>,
}

fn venue(env: &Env) -> Venue<'_> {
    let storage = env.storage().instance();
    storage.extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_TO);
    let router: Address = storage.get(&DataKey::Router).unwrap();
    let usdc: Address = storage.get(&DataKey::Usdc).unwrap();
    Venue {
        zap: env.current_contract_address(),
        usdc: TokenClient::new(env, &usdc),
        router: RouterClient::new(env, &router),
    }
}

fn sub(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_sub(b)
        .unwrap_or_else(|| panic_with_error!(env, ZapError::Overflow))
}

/// One swap path per non-USDC component, in `components()` order, each
/// running from USDC to the leg (`into_fund`) or from the leg to USDC.
fn legs_with_paths(
    env: &Env,
    components: &Vec<Component>,
    paths: &Vec<Vec<Address>>,
    usdc: &Address,
    into_fund: bool,
) -> Vec<(u32, Vec<Address>)> {
    let mut legs = Vec::new(env);
    for (index, component) in components.iter().enumerate() {
        if component.token == *usdc {
            continue;
        }
        let path = paths
            .get(legs.len())
            .unwrap_or_else(|| panic_with_error!(env, ZapError::MissingPath));
        let (from, to) = if into_fund {
            (usdc, &component.token)
        } else {
            (&component.token, usdc)
        };
        if path.len() < 2
            || path.len() > MAX_PATH
            || path.first_unchecked() != *from
            || path.last_unchecked() != *to
        {
            panic_with_error!(env, ZapError::InvalidPath);
        }
        legs.push_back((index as u32, path));
    }
    if legs.len() != paths.len() {
        panic_with_error!(env, ZapError::MissingPath);
    }
    legs
}

fn transfer_auth(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> InvokerContractAuthEntry {
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(env, "transfer"),
            args: (from.clone(), to.clone(), amount).into_val(env),
        },
        sub_invocations: Vec::new(env),
    })
}

/// Authorizes the one transfer the next router swap makes on the zap's
/// behalf: `amount` of `path[0]` into the route's first pair.
fn authorize_swap_input(env: &Env, venue: &Venue, path: &Vec<Address>, amount: i128) {
    let token = path.first_unchecked();
    let pair = venue.router.router_pair_for(&token, &path.get_unchecked(1));
    env.authorize_as_current_contract(vec![
        env,
        transfer_auth(env, &token, &venue.zap, &pair, amount),
    ]);
}

fn deadline(env: &Env) -> u64 {
    env.ledger().timestamp() + 1
}

/// The components of a fund one of the trusted platforms created. A genuine
/// fund never lists a token twice; the check stays so that `quote_issue`
/// needs line up one to one with the pulls the zap authorizes.
fn genuine_components(env: &Env, fund: &FundClient) -> Vec<Component> {
    let platforms: Vec<Address> = env.storage().instance().get(&DataKey::Platforms).unwrap();
    if !platforms
        .iter()
        .any(|platform| PlatformClient::new(env, &platform).is_fund(&fund.address))
    {
        panic_with_error!(env, ZapError::UnknownFund);
    }
    let components = fund.components();
    for (i, component) in components.iter().enumerate() {
        if components
            .iter()
            .skip(i + 1)
            .any(|other| other.token == component.token)
        {
            panic_with_error!(env, ZapError::DuplicateComponent);
        }
    }
    components
}

fn holdings(env: &Env, venue: &Venue, components: &Vec<Component>) -> Vec<i128> {
    let mut held = Vec::new(env);
    for component in components.iter() {
        held.push_back(TokenClient::new(env, &component.token).balance(&venue.zap));
    }
    held
}

fn require_unchanged(env: &Env, venue: &Venue, components: &Vec<Component>, before: &Vec<i128>) {
    if holdings(env, venue, components) != *before {
        panic_with_error!(env, ZapError::HoldingsChanged);
    }
}

#[contractimpl]
impl Zap {
    /// `platforms` are the platforms whose funds the zap serves, fixed for
    /// the zap's life: one to `MAX_PLATFORMS`.
    pub fn __constructor(env: Env, router: Address, usdc: Address, platforms: Vec<Address>) {
        if platforms.is_empty() || platforms.len() > MAX_PLATFORMS {
            panic_with_error!(&env, ZapError::InvalidPlatforms);
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Router, &router);
        storage.set(&DataKey::Usdc, &usdc);
        storage.set(&DataKey::Platforms, &platforms);
        storage.extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_TO);
    }

    pub fn platforms(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Platforms).unwrap()
    }

    pub fn router(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Router).unwrap()
    }

    pub fn usdc(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Usdc).unwrap()
    }

    /// Buys `shares` of `fund` for `investor` with at most `max_usdc`.
    /// `fund` must come from one of `platforms()`. `paths` holds one Soroswap route per non-USDC component, in
    /// `components()` order, from USDC to that component. Each leg is bought
    /// exact-out for what `quote_issue` asks, the zap deposits the basket and
    /// the shares are minted to `investor`. Unspent USDC goes back to the
    /// investor. Returns the USDC spent.
    pub fn issue_with_usdc(
        env: Env,
        investor: Address,
        fund: Address,
        shares: i128,
        max_usdc: i128,
        paths: Vec<Vec<Address>>,
    ) -> i128 {
        investor.require_auth();
        if shares <= 0 || max_usdc <= 0 {
            panic_with_error!(&env, ZapError::InvalidAmount);
        }
        let venue = venue(&env);
        let usdc = venue.usdc.address.clone();
        let fund_client = FundClient::new(&env, &fund);
        let components = genuine_components(&env, &fund_client);
        let legs = legs_with_paths(&env, &components, &paths, &usdc, true);
        let needs = fund_client.quote_issue(&shares);

        let before = holdings(&env, &venue, &components);
        let usdc_before = venue.usdc.balance(&venue.zap);
        venue.usdc.transfer(&investor, &venue.zap, &max_usdc);
        let usdc_leg = components
            .iter()
            .zip(needs.iter())
            .find(|(component, _)| component.token == usdc)
            .map_or(0, |(_, need)| need);
        if usdc_leg > max_usdc {
            panic_with_error!(&env, ZapError::SlippageExceeded);
        }

        for (index, path) in legs.iter() {
            let need = needs.get_unchecked(index);
            if need <= 0 {
                continue;
            }
            let budget = sub(
                &env,
                sub(&env, venue.usdc.balance(&venue.zap), usdc_before),
                usdc_leg,
            );
            let cost = venue
                .router
                .router_get_amounts_in(&need, &path)
                .first_unchecked();
            if cost <= 0 || cost > budget {
                panic_with_error!(&env, ZapError::SlippageExceeded);
            }
            let leg = TokenClient::new(&env, &components.get_unchecked(index).token);
            let leg_before = leg.balance(&venue.zap);
            authorize_swap_input(&env, &venue, &path, cost);
            venue.router.swap_tokens_for_exact_tokens(
                &need,
                &cost,
                &path,
                &venue.zap,
                &deadline(&env),
            );
            let surplus = sub(&env, sub(&env, leg.balance(&venue.zap), leg_before), need);
            if surplus < 0 {
                panic_with_error!(&env, ZapError::SlippageExceeded);
            }
            if surplus > 0 {
                leg.transfer(&venue.zap, &investor, &surplus);
            }
        }

        let mut pulls = Vec::new(&env);
        for (component, need) in components.iter().zip(needs.iter()) {
            if need > 0 {
                pulls.push_back(transfer_auth(
                    &env,
                    &component.token,
                    &venue.zap,
                    &fund,
                    need,
                ));
            }
        }
        env.authorize_as_current_contract(pulls);
        fund_client.issue(&venue.zap, &investor, &shares);

        let unspent = sub(&env, venue.usdc.balance(&venue.zap), usdc_before);
        if unspent < 0 {
            panic_with_error!(&env, ZapError::SlippageExceeded);
        }
        if unspent > 0 {
            venue.usdc.transfer(&venue.zap, &investor, &unspent);
        }
        require_unchanged(&env, &venue, &components, &before);
        let usdc_spent = sub(&env, max_usdc, unspent);
        ZapIssue {
            investor,
            fund,
            shares,
            usdc_spent,
        }
        .publish(&env);
        usdc_spent
    }

    /// Redeems `shares` of `fund` from `owner` and pays the owner the whole
    /// basket in USDC, at least `min_usdc`. `fund` must come from one of
    /// `platforms()`. `paths` holds one Soroswap route
    /// per non-USDC component, in `components()` order, from that component
    /// to USDC. A leg too small to swap to a single unit of USDC is sent to
    /// the owner as is. Returns the USDC paid.
    pub fn redeem_to_usdc(
        env: Env,
        owner: Address,
        fund: Address,
        shares: i128,
        min_usdc: i128,
        paths: Vec<Vec<Address>>,
    ) -> i128 {
        owner.require_auth();
        if shares <= 0 || min_usdc < 0 {
            panic_with_error!(&env, ZapError::InvalidAmount);
        }
        let venue = venue(&env);
        let usdc = venue.usdc.address.clone();
        let fund_client = FundClient::new(&env, &fund);
        let components = genuine_components(&env, &fund_client);
        let legs = legs_with_paths(&env, &components, &paths, &usdc, false);

        let before = holdings(&env, &venue, &components);
        let usdc_before = venue.usdc.balance(&venue.zap);
        fund_client.redeem(&owner, &venue.zap, &shares, &Vec::new(&env));

        // What the redeem delivered, by balance: never the fund's report.
        for (index, path) in legs.iter() {
            let leg = TokenClient::new(&env, &components.get_unchecked(index).token);
            let amount = sub(&env, leg.balance(&venue.zap), before.get_unchecked(index));
            if amount <= 0 {
                continue;
            }
            let quoted = venue
                .router
                .router_get_amounts_out(&amount, &path)
                .last_unchecked();
            if quoted <= 0 {
                leg.transfer(&venue.zap, &owner, &amount);
                continue;
            }
            authorize_swap_input(&env, &venue, &path, amount);
            venue.router.swap_exact_tokens_for_tokens(
                &amount,
                &0,
                &path,
                &venue.zap,
                &deadline(&env),
            );
        }

        let usdc_out = sub(&env, venue.usdc.balance(&venue.zap), usdc_before);
        if usdc_out < min_usdc {
            panic_with_error!(&env, ZapError::SlippageExceeded);
        }
        if usdc_out > 0 {
            venue.usdc.transfer(&venue.zap, &owner, &usdc_out);
        }
        require_unchanged(&env, &venue, &components, &before);
        ZapRedeem {
            owner,
            fund,
            shares,
            usdc_out,
        }
        .publish(&env);
        usdc_out
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_mainnet;
