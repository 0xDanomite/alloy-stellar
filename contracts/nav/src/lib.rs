//! Alloy NAV: what a fund share is worth in USD, read from SEP-40 oracles.
//!
//! Read-only with respect to funds. It holds no assets and calls only fund
//! views; issue and redeem never consult a price, so a bad feed can mislabel
//! a share but cannot move a single unit.
//!
//! Each token has a primary route and an optional secondary. The primary is
//! used while fresh; a stale, missing or failing primary falls back to the
//! secondary. When both are fresh the quote reports how far apart they are.
#![no_std]

mod oracle;

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    token::TokenClient, Address, Env, Symbol, Vec,
};

pub use oracle::{
    Asset, FeedPriceData, PriceData, RedStoneFeed, RedStoneFeedClient, Sep40, Sep40Client,
};

pub const PRICE_DECIMALS: u32 = 8;
pub const SHARE_SCALE: i128 = 10_000_000;
const PRICE_SCALE: i128 = 100_000_000;
const BPS: i128 = 10_000;
/// Any oracle timestamp above this (year 5138 in seconds) is in milliseconds.
const MS_THRESHOLD: u64 = 100_000_000_000;

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const ENTRY_BUMP: u32 = 60 * DAY_IN_LEDGERS;
const ENTRY_THRESHOLD: u32 = ENTRY_BUMP - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum NavError {
    NoRoute = 1,
    NoFreshPrice = 2,
    Overflow = 3,
    InvalidRoute = 4,
    ShapeMismatch = 5,
}

/// The unit an oracle quotes in. A `Usdc` price is converted to USD through
/// the USDC token's own USD-quoted route, never assumed to be 1:1.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Quote {
    Usd,
    Usdc,
}

/// How to ask `Route::oracle` for a price: a SEP-40 `lastprice(asset)`, or
/// a single-feed RedStone contract's `read_price_data()`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Feed {
    Sep40(Asset),
    RedStoneFeed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Route {
    pub oracle: Address,
    pub feed: Feed,
    pub quote: Quote,
    pub max_age_secs: u64,
    pub source: Symbol,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceQuote {
    pub price: i128,
    pub timestamp: u64,
    pub source: Symbol,
    pub divergence_bps: Option<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegNav {
    pub token: Address,
    pub units_per_share: i128,
    pub price: i128,
    pub value_usd: i128,
    pub source: Symbol,
    pub timestamp: u64,
    pub divergence_bps: Option<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundNav {
    pub per_share_usd: i128,
    pub legs: Vec<LegNav>,
    pub total_usd: i128,
}

/// Mirrors `alloy_fund::Component`; identical field names give identical XDR.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub token: Address,
    pub initial_units: i128,
}

#[contractclient(name = "FundClient")]
pub trait FundViews {
    fn components(env: Env) -> Vec<Component>;
    fn units_per_share(env: Env) -> Vec<i128>;
    fn total_supply(env: Env) -> i128;
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Usdc,
    Primary(Address),
    Secondary(Address),
}

#[contractevent(topics = ["route_set"])]
pub struct RouteSet {
    #[topic]
    pub token: Address,
    pub primary: Route,
    pub secondary: Option<Route>,
}

#[contractevent(topics = ["route_removed"], data_format = "single-value")]
pub struct RouteRemoved {
    #[topic]
    pub token: Address,
    pub removed: bool,
}

#[contractevent(topics = ["admin_set"])]
pub struct AdminSet {
    #[topic]
    pub previous: Address,
    #[topic]
    pub admin: Address,
}

#[contract]
pub struct Nav;

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_route_entry(env: &Env, key: DataKey) -> Option<Route> {
    let storage = env.storage().persistent();
    let route = storage.get(&key);
    if route.is_some() {
        storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
    }
    route
}

fn primary(env: &Env, token: &Address) -> Option<Route> {
    read_route_entry(env, DataKey::Primary(token.clone()))
}

fn secondary(env: &Env, token: &Address) -> Option<Route> {
    read_route_entry(env, DataKey::Secondary(token.clone()))
}

fn mul_div(a: i128, b: i128, denominator: i128) -> Result<i128, NavError> {
    a.checked_mul(b)
        .and_then(|p| p.checked_div(denominator))
        .ok_or(NavError::Overflow)
}

fn pow10(exp: u32) -> Result<i128, NavError> {
    10i128.checked_pow(exp).ok_or(NavError::Overflow)
}

fn to_price_decimals(raw: i128, decimals: u32) -> Result<i128, NavError> {
    if decimals >= PRICE_DECIMALS {
        Ok(raw / pow10(decimals - PRICE_DECIMALS)?)
    } else {
        raw.checked_mul(pow10(PRICE_DECIMALS - decimals)?)
            .ok_or(NavError::Overflow)
    }
}

fn seconds(timestamp: u64) -> u64 {
    if timestamp > MS_THRESHOLD {
        timestamp / 1000
    } else {
        timestamp
    }
}

/// A fresh, positive price from one oracle, in its quote unit at 8 decimals.
/// Anything an oracle does wrong (no entry, a panic, a wrong shape, a zero)
/// reads as "no price" so the caller can fall back.
fn read_raw(env: &Env, route: &Route) -> Result<Option<(i128, u64)>, NavError> {
    let reading = match &route.feed {
        Feed::Sep40(asset) => read_sep40(env, &route.oracle, asset),
        Feed::RedStoneFeed => read_redstone_feed(env, &route.oracle),
    };
    let Some((raw, decimals, timestamp)) = reading else {
        return Ok(None);
    };
    let timestamp = seconds(timestamp);
    let age = env.ledger().timestamp().saturating_sub(timestamp);
    if raw <= 0 || age > route.max_age_secs {
        return Ok(None);
    }
    let price = to_price_decimals(raw, decimals)?;
    if price <= 0 {
        return Ok(None);
    }
    Ok(Some((price, timestamp)))
}

fn read_sep40(env: &Env, oracle: &Address, asset: &Asset) -> Option<(i128, u32, u64)> {
    let client = Sep40Client::new(env, oracle);
    let data = client.try_lastprice(asset).ok()?.ok()??;
    let decimals = client.try_decimals().ok()?.ok()?;
    Some((data.price, decimals, data.timestamp))
}

fn read_redstone_feed(env: &Env, oracle: &Address) -> Option<(i128, u32, u64)> {
    let client = RedStoneFeedClient::new(env, oracle);
    let data = client.try_read_price_data().ok()?.ok()?;
    let decimals = u32::try_from(client.try_decimals().ok()?.ok()?).ok()?;
    let price = i128::try_from(data.price.to_u128()?).ok()?;
    Some((price, decimals, data.package_timestamp))
}

/// USDC in USD from the first fresh USD-quoted route configured for USDC.
fn usdc_in_usd(env: &Env) -> Result<Option<(i128, u64)>, NavError> {
    let usdc: Address = env.storage().instance().get(&DataKey::Usdc).unwrap();
    for route in [primary(env, &usdc), secondary(env, &usdc)]
        .into_iter()
        .flatten()
    {
        if route.quote != Quote::Usd {
            continue;
        }
        if let Some(found) = read_raw(env, &route)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn read_route(env: &Env, route: &Route) -> Result<Option<(i128, u64)>, NavError> {
    let Some((price, timestamp)) = read_raw(env, route)? else {
        return Ok(None);
    };
    match route.quote {
        Quote::Usd => Ok(Some((price, timestamp))),
        Quote::Usdc => {
            let Some((usdc, usdc_timestamp)) = usdc_in_usd(env)? else {
                return Ok(None);
            };
            Ok(Some((
                mul_div(price, usdc, PRICE_SCALE)?,
                timestamp.min(usdc_timestamp),
            )))
        }
    }
}

fn divergence_bps(primary: i128, secondary: i128) -> Result<u32, NavError> {
    let gap = primary.checked_sub(secondary).ok_or(NavError::Overflow)?;
    let bps = mul_div(gap.abs(), BPS, primary)?;
    Ok(u32::try_from(bps).unwrap_or(u32::MAX))
}

fn price(env: &Env, token: &Address) -> Result<PriceQuote, NavError> {
    let primary_route = primary(env, token).ok_or(NavError::NoRoute)?;
    let fresh_primary = read_route(env, &primary_route)?;
    let fresh_secondary = match secondary(env, token) {
        Some(route) => read_route(env, &route)?.map(|found| (found, route.source)),
        None => None,
    };
    match (fresh_primary, fresh_secondary) {
        (Some((price, timestamp)), secondary) => Ok(PriceQuote {
            price,
            timestamp,
            source: primary_route.source,
            divergence_bps: match secondary {
                Some(((other, _), _)) => Some(divergence_bps(price, other)?),
                None => None,
            },
        }),
        (None, Some(((price, timestamp), source))) => Ok(PriceQuote {
            price,
            timestamp,
            source,
            divergence_bps: None,
        }),
        (None, None) => Err(NavError::NoFreshPrice),
    }
}

fn validate(route: &Route) -> Result<(), NavError> {
    if route.max_age_secs == 0 {
        return Err(NavError::InvalidRoute);
    }
    Ok(())
}

#[contractimpl]
impl Nav {
    /// `usdc` is the token whose USD-quoted route converts USDC-quoted feeds.
    pub fn __constructor(env: Env, admin: Address, usdc: Address) {
        let instance = env.storage().instance();
        instance.set(&DataKey::Admin, &admin);
        instance.set(&DataKey::Usdc, &usdc);
        bump_instance(&env);
    }

    pub fn set_route(
        env: Env,
        token: Address,
        primary: Route,
        secondary: Option<Route>,
    ) -> Result<(), NavError> {
        admin(&env).require_auth();
        bump_instance(&env);
        validate(&primary)?;
        if let Some(route) = &secondary {
            validate(route)?;
        }
        let storage = env.storage().persistent();
        let primary_key = DataKey::Primary(token.clone());
        storage.set(&primary_key, &primary);
        storage.extend_ttl(&primary_key, ENTRY_THRESHOLD, ENTRY_BUMP);
        let secondary_key = DataKey::Secondary(token.clone());
        match &secondary {
            Some(route) => {
                storage.set(&secondary_key, route);
                storage.extend_ttl(&secondary_key, ENTRY_THRESHOLD, ENTRY_BUMP);
            }
            None => storage.remove(&secondary_key),
        }
        RouteSet {
            token,
            primary,
            secondary,
        }
        .publish(&env);
        Ok(())
    }

    pub fn remove_route(env: Env, token: Address) {
        admin(&env).require_auth();
        bump_instance(&env);
        let storage = env.storage().persistent();
        let primary_key = DataKey::Primary(token.clone());
        let removed = storage.has(&primary_key);
        storage.remove(&primary_key);
        storage.remove(&DataKey::Secondary(token.clone()));
        RouteRemoved { token, removed }.publish(&env);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let previous = admin(&env);
        previous.require_auth();
        new_admin.require_auth();
        bump_instance(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        AdminSet {
            previous,
            admin: new_admin,
        }
        .publish(&env);
    }

    pub fn admin(env: Env) -> Address {
        admin(&env)
    }

    pub fn usdc(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Usdc).unwrap()
    }

    pub fn primary(env: Env, token: Address) -> Option<Route> {
        primary(&env, &token)
    }

    pub fn secondary(env: Env, token: Address) -> Option<Route> {
        secondary(&env, &token)
    }

    /// USD price of one whole token, 8 decimals.
    pub fn price(env: Env, token: Address) -> Result<PriceQuote, NavError> {
        bump_instance(&env);
        price(&env, &token)
    }

    /// USD value of one whole share (10^7 base units), 8 decimals. Fails if
    /// any leg has no fresh price: a NAV that skips a leg is not a NAV.
    pub fn nav(env: Env, fund: Address) -> Result<FundNav, NavError> {
        bump_instance(&env);
        let client = FundClient::new(&env, &fund);
        let components = client.components();
        let units = client.units_per_share();
        if units.len() != components.len() {
            return Err(NavError::ShapeMismatch);
        }
        let mut legs = Vec::new(&env);
        let mut per_share_usd: i128 = 0;
        for (component, units_per_share) in components.iter().zip(units.iter()) {
            let quote = price(&env, &component.token)?;
            let decimals = TokenClient::new(&env, &component.token).decimals();
            let value_usd = mul_div(units_per_share, quote.price, pow10(decimals)?)?;
            per_share_usd = per_share_usd
                .checked_add(value_usd)
                .ok_or(NavError::Overflow)?;
            legs.push_back(LegNav {
                token: component.token,
                units_per_share,
                price: quote.price,
                value_usd,
                source: quote.source,
                timestamp: quote.timestamp,
                divergence_bps: quote.divergence_bps,
            });
        }
        let total_usd = mul_div(per_share_usd, client.total_supply(), SHARE_SCALE)?;
        Ok(FundNav {
            per_share_usd,
            legs,
            total_usd,
        })
    }
}

#[cfg(test)]
mod test;
