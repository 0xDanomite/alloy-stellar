use kanatoko::soroban_sdk;
use kanatoko::soroban_sdk::{contracttype, testutils::Ledger as _, Address, Symbol};
use kanatoko::{mainnet, AutoRunner, ScenarioFork};

mod nav {
    use kanatoko::soroban_sdk;
    soroban_sdk::contractimport!(file = "wasm/alloy_nav.wasm");
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct PriceData {
    price: i128,
    timestamp: u64,
}

const REDSTONE: &str = "CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF";
const REFLECTOR: &str = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
const XLM: &str = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

fn runner(name: &str) -> AutoRunner {
    let path = format!("{}/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let runner = mainnet().cache(path);
    match std::env::var("KANATOKO_CAPTURE_RPC") {
        Ok(url) => runner.rpc_url(url).rpc_rate_limit(4).refresh(),
        Err(_) => runner.offline(),
    }
}

fn feed(fork: &ScenarioFork<'_>, oracle: &Address, token: &Address) -> PriceData {
    fork.invoke::<Option<PriceData>>(oracle, "lastprice", (nav::Asset::Stellar(token.clone()),))
        .unwrap()
}

fn route(
    fork: &ScenarioFork<'_>,
    token: &Address,
    reflector: bool,
    max_age_secs: u64,
) -> nav::Route {
    nav::Route {
        oracle: fork.contract(if reflector { REFLECTOR } else { REDSTONE }),
        feed: nav::Feed::Sep40(nav::Asset::Stellar(token.clone())),
        quote: if reflector {
            nav::Quote::Usdc
        } else {
            nav::Quote::Usd
        },
        max_age_secs,
        source: Symbol::new(fork.env(), if reflector { "reflector" } else { "redstone" }),
    }
}

fn configure(fork: &ScenarioFork<'_>, reflector_age: u64) -> Address {
    fork.mock_all_auths();
    let usdc = fork.contract(USDC);
    let xlm = fork.contract(XLM);
    let admin = fork.local_account("alloy-nav-admin");
    let address = fork.deploy(nav::WASM, (&admin, &usdc));
    let client = nav::Client::new(fork.env(), &address);
    // Exactly the existing mainnet test's USDC routes; conversion uses its USD-quoted secondary.
    client.set_route(
        &usdc,
        &route(fork, &usdc, true, 900),
        &Some(route(fork, &usdc, false, 26 * 3600)),
    );
    client.set_route(
        &xlm,
        &route(fork, &xlm, true, reflector_age),
        &Some(route(fork, &xlm, false, 26 * 3600)),
    );
    address
}

fn seconds(t: u64) -> u64 {
    if t > 100_000_000_000 {
        t / 1000
    } else {
        t
    }
}

fn assert_source(
    fork: &ScenarioFork<'_>,
    address: &Address,
    token: &Address,
    timestamp: u64,
    source: &str,
) {
    fork.env().ledger().set_timestamp(timestamp);
    let quote = nav::Client::new(fork.env(), address).price(token);
    assert!(quote.price > 0);
    assert_eq!(quote.source, Symbol::new(fork.env(), source));
}

#[test]
fn primary_expiry_falls_back_then_all_routes_expire() {
    runner("primary-expiry")
        .run(|fork| {
            let xlm = fork.contract(XLM);
            let usdc = fork.contract(USDC);
            let primary = feed(fork, &fork.contract(REFLECTOR), &xlm);
            let secondary = feed(fork, &fork.contract(REDSTONE), &xlm);
            let conversion = feed(fork, &fork.contract(REDSTONE), &usdc);
            let now = fork.env().ledger().timestamp();
            let expiry = seconds(primary.timestamp) + 900;
            let secondary_expiry = seconds(secondary.timestamp) + 26 * 3600;
            assert!(now < expiry - 1);
            assert!(seconds(conversion.timestamp) + 26 * 3600 > expiry);
            assert!(secondary_expiry > expiry + 1);
            let address = configure(fork, 900);
            assert_source(fork, &address, &xlm, now, "reflector");
            for t in [expiry - 1, expiry] {
                assert_source(fork, &address, &xlm, t, "reflector");
            }
            assert_source(fork, &address, &xlm, expiry + 1, "redstone");
            for t in [secondary_expiry - 1, secondary_expiry] {
                assert_source(fork, &address, &xlm, t, "redstone");
            }
            fork.env().ledger().set_timestamp(secondary_expiry + 1);
            assert_eq!(
                nav::Client::new(fork.env(), &address).try_price(&xlm),
                Err(Ok(nav::NavError::NoFreshPrice))
            );
            assert_eq!(feed(fork, &fork.contract(REFLECTOR), &xlm), primary);
            assert_eq!(feed(fork, &fork.contract(REDSTONE), &xlm), secondary);
            println!("primary now={now} expiry={expiry} secondary_expiry={secondary_expiry}");
        })
        .unwrap();
}

#[test]
fn stale_conversion_leg_triggers_fallback_while_asset_feed_is_fresh() {
    runner("conversion-expiry")
        .run(|fork| {
            let xlm = fork.contract(XLM);
            let usdc = fork.contract(USDC);
            let primary = feed(fork, &fork.contract(REFLECTOR), &xlm);
            let conversion = feed(fork, &fork.contract(REDSTONE), &usdc);
            let secondary = feed(fork, &fork.contract(REDSTONE), &xlm);
            let now = fork.env().ledger().timestamp();
            let expiry = seconds(conversion.timestamp) + 26 * 3600;
            let secondary_expiry = seconds(secondary.timestamp) + 26 * 3600;
            // One explicit local configuration variation isolates the conversion leg.
            // Oracle code, stored feed prices and timestamps are never replaced or edited.
            let reflector_age = 27 * 3600;
            assert!(now < expiry - 1);
            assert!(seconds(primary.timestamp) + reflector_age > expiry + 1);
            assert!(secondary_expiry > expiry + 1);
            let address = configure(fork, reflector_age);
            for t in [now, expiry - 1, expiry] {
                assert_source(fork, &address, &xlm, t, "reflector");
            }
            assert_source(fork, &address, &xlm, expiry + 1, "redstone");
            assert_eq!(
                nav::Client::new(fork.env(), &address).try_price(&usdc),
                Err(Ok(nav::NavError::NoFreshPrice))
            );
            assert_eq!(feed(fork, &fork.contract(REFLECTOR), &xlm), primary);
            assert_eq!(feed(fork, &fork.contract(REDSTONE), &usdc), conversion);
            fork.env().ledger().set_timestamp(secondary_expiry + 1);
            assert_eq!(
                nav::Client::new(fork.env(), &address).try_price(&xlm),
                Err(Ok(nav::NavError::NoFreshPrice))
            );
            println!("conversion now={now} expiry={expiry} secondary_expiry={secondary_expiry}");
        })
        .unwrap();
}
