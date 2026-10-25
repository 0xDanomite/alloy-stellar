extern crate std;

use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    vec, Address, Env, IntoVal, String, Symbol, U256,
};

use crate::{Asset, Feed, FeedPriceData, Nav, NavClient, NavError, PriceData, Quote, Route};

mod fund_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/alloy_fund.wasm");
}

const NOW: u64 = 1_792_943_000;
const HOUR: u64 = 3_600;

#[contract]
struct MockSep40;

#[contractimpl]
impl MockSep40 {
    pub fn __constructor(env: Env, decimals: u32) {
        env.storage()
            .instance()
            .set(&symbol_short!("dec"), &decimals);
    }

    pub fn set(env: Env, asset: Asset, price: i128, timestamp: u64) {
        env.storage()
            .persistent()
            .set(&asset, &PriceData { price, timestamp });
    }

    pub fn break_feed(env: Env) {
        env.storage()
            .instance()
            .set(&symbol_short!("broken"), &true);
    }

    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        if env.storage().instance().has(&symbol_short!("broken")) {
            panic!("feed offline");
        }
        env.storage().persistent().get(&asset)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&symbol_short!("dec")).unwrap()
    }
}

#[contract]
struct MockRedStoneFeed;

#[contractimpl]
impl MockRedStoneFeed {
    pub fn set(env: Env, price: u128, timestamp_ms: u64) {
        let data = FeedPriceData {
            price: U256::from_u128(&env, price),
            package_timestamp: timestamp_ms,
            write_timestamp: timestamp_ms + 8_000,
        };
        env.storage().instance().set(&symbol_short!("data"), &data);
    }

    pub fn read_price_data(env: Env) -> FeedPriceData {
        env.storage()
            .instance()
            .get(&symbol_short!("data"))
            .unwrap()
    }

    pub fn decimals(_env: Env) -> u64 {
        8
    }
}

struct Setup<'a> {
    env: Env,
    nav: NavClient<'a>,
    admin: Address,
    usdc: Address,
    redstone: MockSep40Client<'a>,
    reflector: MockSep40Client<'a>,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.ledger().set_timestamp(NOW);
    let admin = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let nav = NavClient::new(&env, &env.register(Nav, (admin.clone(), usdc.clone())));
    let redstone = MockSep40Client::new(&env, &env.register(MockSep40, (8u32,)));
    let reflector = MockSep40Client::new(&env, &env.register(MockSep40, (14u32,)));
    Setup {
        env,
        nav,
        admin,
        usdc,
        redstone,
        reflector,
    }
}

fn redstone_route(s: &Setup, token: &Address) -> Route {
    Route {
        oracle: s.redstone.address.clone(),
        feed: Feed::Sep40(Asset::Stellar(token.clone())),
        quote: Quote::Usd,
        max_age_secs: 26 * HOUR,
        source: Symbol::new(&s.env, "redstone"),
    }
}

fn reflector_route(s: &Setup, token: &Address) -> Route {
    Route {
        oracle: s.reflector.address.clone(),
        feed: Feed::Sep40(Asset::Stellar(token.clone())),
        quote: Quote::Usdc,
        max_age_secs: 15 * 60,
        source: Symbol::new(&s.env, "reflector"),
    }
}

fn stellar(token: &Address) -> Asset {
    Asset::Stellar(token.clone())
}

fn new_token(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env))
        .address()
}

/// USDC at exactly $1 on RedStone, so Reflector prices pass through unscaled.
fn route_usdc(s: &Setup, usd_price: i128) {
    s.env.mock_all_auths();
    s.redstone.set(&stellar(&s.usdc), &usd_price, &(NOW - HOUR));
    s.reflector
        .set(&stellar(&s.usdc), &100_000_000_000_000, &(NOW - 60));
    s.nav.set_route(
        &s.usdc,
        &reflector_route(s, &s.usdc),
        &Some(redstone_route(s, &s.usdc)),
    );
}

fn err(
    result: Result<impl core::fmt::Debug, Result<NavError, soroban_sdk::InvokeError>>,
) -> NavError {
    match result {
        Err(Ok(error)) => error,
        other => panic!("expected a NavError, got {other:?}"),
    }
}

#[test]
fn fresh_primary_wins_and_reports_divergence() {
    let s = setup();
    route_usdc(&s, 100_000_000);
    let token = new_token(&s.env);
    s.redstone
        .set(&stellar(&token), &107_815_400, &(NOW - 4 * HOUR));
    s.reflector
        .set(&stellar(&token), &107_571_089_178_203, &(NOW - 100));
    s.nav.set_route(
        &token,
        &redstone_route(&s, &token),
        &Some(reflector_route(&s, &token)),
    );

    let quote = s.nav.price(&token);
    assert_eq!(quote.price, 107_815_400);
    assert_eq!(quote.timestamp, NOW - 4 * HOUR);
    assert_eq!(quote.source, Symbol::new(&s.env, "redstone"));
    // |1.07815400 - 1.07571089| / 1.07815400 = 22.66 bps, floored.
    assert_eq!(quote.divergence_bps, Some(22));
}

#[test]
fn stale_primary_falls_back_to_secondary() {
    let s = setup();
    route_usdc(&s, 100_000_000);
    let token = new_token(&s.env);
    s.redstone
        .set(&stellar(&token), &107_815_400, &(NOW - 27 * HOUR));
    s.reflector
        .set(&stellar(&token), &107_571_089_178_203, &(NOW - 100));
    s.nav.set_route(
        &token,
        &redstone_route(&s, &token),
        &Some(reflector_route(&s, &token)),
    );

    let quote = s.nav.price(&token);
    assert_eq!(quote.price, 107_571_089);
    assert_eq!(quote.source, Symbol::new(&s.env, "reflector"));
    assert_eq!(quote.divergence_bps, None);
}

#[test]
fn missing_or_broken_primary_falls_back() {
    let s = setup();
    route_usdc(&s, 100_000_000);
    let token = new_token(&s.env);
    let flaky = MockSep40Client::new(&s.env, &s.env.register(MockSep40, (8u32,)));
    let mut primary = redstone_route(&s, &token);
    primary.oracle = flaky.address.clone();
    s.reflector.set(&stellar(&token), &50_000_000_000_000, &NOW);
    s.nav
        .set_route(&token, &primary, &Some(reflector_route(&s, &token)));
    assert_eq!(s.nav.price(&token).price, 50_000_000);

    flaky.set(&stellar(&token), &51_000_000, &NOW);
    assert_eq!(s.nav.price(&token).price, 51_000_000);
    flaky.break_feed();
    let quote = s.nav.price(&token);
    assert_eq!(quote.source, Symbol::new(&s.env, "reflector"));
    assert_eq!(quote.price, 50_000_000);
}

#[test]
fn both_stale_is_an_error() {
    let s = setup();
    route_usdc(&s, 100_000_000);
    let token = new_token(&s.env);
    s.redstone
        .set(&stellar(&token), &107_815_400, &(NOW - 27 * HOUR));
    s.reflector
        .set(&stellar(&token), &107_571_089_178_203, &(NOW - 16 * 60));
    s.nav.set_route(
        &token,
        &redstone_route(&s, &token),
        &Some(reflector_route(&s, &token)),
    );
    assert_eq!(err(s.nav.try_price(&token)), NavError::NoFreshPrice);
}

#[test]
fn unrouted_token_is_an_error() {
    let s = setup();
    assert_eq!(err(s.nav.try_price(&new_token(&s.env))), NavError::NoRoute);
}

#[test]
fn zero_and_negative_prices_are_ignored() {
    let s = setup();
    let token = new_token(&s.env);
    s.env.mock_all_auths();
    s.redstone.set(&stellar(&token), &0, &NOW);
    s.nav.set_route(&token, &redstone_route(&s, &token), &None);
    assert_eq!(err(s.nav.try_price(&token)), NavError::NoFreshPrice);
    s.redstone.set(&stellar(&token), &-5, &NOW);
    assert_eq!(err(s.nav.try_price(&token)), NavError::NoFreshPrice);
}

#[test]
fn normalizes_8_and_14_decimal_oracles_and_usdc_quotes() {
    let s = setup();
    // Live mainnet readings: RedStone USDC/USD and Reflector XLM/USDC.
    route_usdc(&s, 99_985_864);
    let xlm = new_token(&s.env);
    s.reflector
        .set(&stellar(&xlm), &16_919_377_758_299, &(NOW - 60));
    s.redstone.set(&stellar(&xlm), &16_942_269, &(NOW - HOUR));
    s.nav.set_route(
        &xlm,
        &reflector_route(&s, &xlm),
        &Some(redstone_route(&s, &xlm)),
    );

    let quote = s.nav.price(&xlm);
    assert_eq!(quote.price, 16_916_985);
    assert_eq!(quote.source, Symbol::new(&s.env, "reflector"));
    // The converted quote is only as fresh as the older of its two readings.
    assert_eq!(quote.timestamp, NOW - HOUR);
    assert_eq!(quote.divergence_bps, Some(14));

    let usdc = s.nav.price(&s.usdc);
    assert_eq!(usdc.price, 99_985_864);
    assert_eq!(usdc.divergence_bps, Some(0));
}

#[test]
fn usdc_quote_without_a_usd_usdc_price_is_unusable() {
    let s = setup();
    let token = new_token(&s.env);
    s.env.mock_all_auths();
    s.reflector.set(&stellar(&token), &50_000_000_000_000, &NOW);
    s.nav.set_route(&token, &reflector_route(&s, &token), &None);
    assert_eq!(err(s.nav.try_price(&token)), NavError::NoFreshPrice);

    // A USDC route that is itself only USDC-quoted cannot price USDC in USD.
    s.reflector
        .set(&stellar(&s.usdc), &100_000_000_000_000, &NOW);
    s.nav
        .set_route(&s.usdc, &reflector_route(&s, &s.usdc), &None);
    assert_eq!(err(s.nav.try_price(&token)), NavError::NoFreshPrice);
}

#[test]
fn millisecond_timestamps_are_normalized() {
    let s = setup();
    let token = new_token(&s.env);
    s.env.mock_all_auths();
    s.redstone
        .set(&stellar(&token), &100_000_000, &((NOW - HOUR) * 1000));
    s.nav.set_route(&token, &redstone_route(&s, &token), &None);
    assert_eq!(s.nav.price(&token).timestamp, NOW - HOUR);
}

#[test]
fn redstone_single_feed_route() {
    let s = setup();
    let token = new_token(&s.env);
    let feed = MockRedStoneFeedClient::new(&s.env, &s.env.register(MockRedStoneFeed, ()));
    feed.set(&100_000_000, &((NOW - 4 * HOUR) * 1000));
    s.env.mock_all_auths();
    let route = Route {
        oracle: feed.address.clone(),
        feed: Feed::RedStoneFeed,
        quote: Quote::Usd,
        max_age_secs: 26 * HOUR,
        source: Symbol::new(&s.env, "redstone"),
    };
    s.nav.set_route(&token, &route, &None);
    let quote = s.nav.price(&token);
    assert_eq!(quote.price, 100_000_000);
    assert_eq!(quote.timestamp, NOW - 4 * HOUR);

    feed.set(&100_000_000, &((NOW - 27 * HOUR) * 1000));
    assert_eq!(err(s.nav.try_price(&token)), NavError::NoFreshPrice);
}

#[test]
fn set_route_needs_admin_and_validates() {
    let s = setup();
    let token = new_token(&s.env);
    let route = redstone_route(&s, &token);
    let args = (token.clone(), route.clone(), None::<Route>).into_val(&s.env);
    s.nav
        .mock_auths(&[MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.nav.address,
                fn_name: "set_route",
                args,
                sub_invokes: &[],
            },
        }])
        .set_route(&token, &route, &None);
    assert_eq!(s.nav.primary(&token), Some(route.clone()));
    assert_eq!(s.nav.secondary(&token), None);

    let stranger = Address::generate(&s.env);
    let args = (token.clone(), route.clone(), None::<Route>).into_val(&s.env);
    assert!(s
        .nav
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &s.nav.address,
                fn_name: "set_route",
                args,
                sub_invokes: &[],
            },
        }])
        .try_set_route(&token, &route, &None)
        .is_err());

    s.env.mock_all_auths();
    let mut bad = route.clone();
    bad.max_age_secs = 0;
    assert_eq!(
        err(s.nav.try_set_route(&token, &route, &Some(bad))),
        NavError::InvalidRoute
    );

    s.nav.set_route(&token, &route, &Some(route.clone()));
    assert_eq!(s.nav.secondary(&token), Some(route.clone()));
    s.nav.remove_route(&token);
    assert_eq!(s.nav.primary(&token), None);
    assert_eq!(s.nav.secondary(&token), None);
}

#[test]
fn set_admin_needs_both_keys() {
    let s = setup();
    let next = Address::generate(&s.env);
    s.env.mock_all_auths();
    s.nav.set_admin(&next);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 2);
    assert!(auths.iter().any(|(who, _)| *who == s.admin));
    assert!(auths.iter().any(|(who, _)| *who == next));
    assert_eq!(s.nav.admin(), next);
}

#[test]
fn nav_over_a_three_leg_fund() {
    let s = setup();
    route_usdc(&s, 100_000_000);
    let env = &s.env;
    let tokens: std::vec::Vec<Address> = (0..3).map(|_| new_token(env)).collect();

    // Leg 0: $1.00 on RedStone. Leg 1: $0.50 on Reflector (USDC quote).
    // Leg 2: $100 on a single RedStone feed.
    s.redstone
        .set(&stellar(&tokens[0]), &100_000_000, &(NOW - HOUR));
    s.nav
        .set_route(&tokens[0], &redstone_route(&s, &tokens[0]), &None);
    s.reflector
        .set(&stellar(&tokens[1]), &50_000_000_000_000, &(NOW - 30));
    s.nav
        .set_route(&tokens[1], &reflector_route(&s, &tokens[1]), &None);
    let feed = MockRedStoneFeedClient::new(env, &env.register(MockRedStoneFeed, ()));
    feed.set(&10_000_000_000, &(NOW * 1000));
    s.nav.set_route(
        &tokens[2],
        &Route {
            oracle: feed.address.clone(),
            feed: Feed::RedStoneFeed,
            quote: Quote::Usd,
            max_age_secs: 26 * HOUR,
            source: Symbol::new(env, "redstone"),
        },
        &None,
    );

    let units = [10_000_000i128, 20_000_000, 5_000_000];
    let mut components = soroban_sdk::Vec::new(env);
    for (token, initial_units) in tokens.iter().zip(units) {
        components.push_back(fund_wasm::Component {
            token: token.clone(),
            initial_units,
        });
    }
    let fund = env.register(
        fund_wasm::WASM,
        (
            Address::generate(env),
            Address::generate(env),
            String::from_str(env, "Alloy Test Fund"),
            String::from_str(env, "aTEST"),
            components,
            fund_wasm::Compliance::Open,
        ),
    );

    // Before the first issue a share is priced off its initial units.
    let nav = s.nav.nav(&fund);
    assert_eq!(nav.per_share_usd, 5_200_000_000);
    assert_eq!(nav.total_usd, 0);
    assert_eq!(nav.legs.len(), 3);
    let leg1 = nav.legs.get(1).unwrap();
    assert_eq!(leg1.price, 50_000_000);
    assert_eq!(leg1.value_usd, 100_000_000);
    assert_eq!(leg1.source, Symbol::new(env, "reflector"));
    assert_eq!(leg1.timestamp, NOW - HOUR);

    let investor = Address::generate(env);
    for token in &tokens {
        StellarAssetClient::new(env, token).mint(&investor, &1_000_000_000);
    }
    fund_wasm::Client::new(env, &fund).issue(&investor, &investor, &20_000_000);
    let nav = s.nav.nav(&fund);
    assert_eq!(nav.per_share_usd, 5_200_000_000);
    assert_eq!(nav.total_usd, 10_400_000_000);
    assert_eq!(
        nav.legs
            .iter()
            .map(|l| l.units_per_share)
            .collect::<std::vec::Vec<_>>(),
        vec![env, 10_000_000i128, 20_000_000, 5_000_000]
            .iter()
            .collect::<std::vec::Vec<_>>()
    );

    // An unpriced leg fails the whole NAV rather than understating it.
    feed.set(&10_000_000_000, &((NOW - 27 * HOUR) * 1000));
    assert_eq!(err(s.nav.try_nav(&fund)), NavError::NoFreshPrice);
}
