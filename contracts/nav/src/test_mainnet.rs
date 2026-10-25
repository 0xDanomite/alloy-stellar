//! Fork test against real mainnet oracle state. Ignored by default; run with
//!
//!   node scripts/oracle-snapshot.mjs mainnet.json
//!   stellar contract build --package alloy-nav
//!   ALLOY_MAINNET_SNAPSHOT=mainnet.json cargo test -p alloy-nav -- --ignored
extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    xdr::{Limits, ScVal, WriteXdr},
    Address, Env, IntoVal, String, Symbol, TryFromVal, Val,
};

use crate::{Asset, Feed, NavClient, Quote, Route};

/// The release-profile build, so instruction counts match what simulation
/// sees. Read at run time so CI can compile this ignored test without it.
const NAV_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/alloy_nav.wasm"
);

mod fund_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/alloy_fund.wasm");
}

const REDSTONE: &str = "CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF";
const REFLECTOR: &str = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
const REDSTONE_BENJI: &str = "CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5";
const XLM: &str = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const USDY: &str = "CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP";
const USTRY: &str = "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR";
const CETES: &str = "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV";
const BENJI: &str = "CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A";

enum Kind {
    RedStone,
    Reflector,
    RedStoneFeed(&'static str),
}

fn route(env: &Env, kind: &Kind, token: &Address) -> Route {
    let sep40 = Feed::Sep40(Asset::Stellar(token.clone()));
    match kind {
        Kind::RedStone => Route {
            oracle: Address::from_str(env, REDSTONE),
            feed: sep40,
            quote: Quote::Usd,
            max_age_secs: 26 * 3600,
            source: Symbol::new(env, "redstone"),
        },
        Kind::Reflector => Route {
            oracle: Address::from_str(env, REFLECTOR),
            feed: sep40,
            quote: Quote::Usdc,
            max_age_secs: 15 * 60,
            source: Symbol::new(env, "reflector"),
        },
        Kind::RedStoneFeed(id) => Route {
            oracle: Address::from_str(env, id),
            feed: Feed::RedStoneFeed,
            quote: Quote::Usd,
            max_age_secs: 26 * 3600,
            source: Symbol::new(env, "redstone"),
        },
    }
}

#[test]
#[ignore]
fn prices_and_nav_from_mainnet_oracles() {
    let path = std::env::var("ALLOY_MAINNET_SNAPSHOT").expect("set ALLOY_MAINNET_SNAPSHOT");
    let wasm = std::fs::read(NAV_WASM).expect("run stellar contract build --package alloy-nav");
    let env = Env::from_ledger_snapshot_file(path);
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let usdc = Address::from_str(&env, USDC);
    let nav = NavClient::new(
        &env,
        &env.register(wasm.as_slice(), (Address::generate(&env), usdc.clone())),
    );

    // USDC first: Reflector quotes in USDC and converts through its route.
    let routes = [
        (USDC, Kind::Reflector, Some(Kind::RedStone)),
        (XLM, Kind::Reflector, Some(Kind::RedStone)),
        (USDY, Kind::RedStone, None),
        (USTRY, Kind::RedStone, Some(Kind::Reflector)),
        (CETES, Kind::RedStone, Some(Kind::Reflector)),
        (BENJI, Kind::RedStoneFeed(REDSTONE_BENJI), None),
    ];
    let mut components = soroban_sdk::Vec::new(&env);
    for (id, primary, secondary) in &routes {
        let token = Address::from_str(&env, id);
        nav.set_route(
            &token,
            &route(&env, primary, &token),
            &secondary.as_ref().map(|k| route(&env, k, &token)),
        );
        let quote = nav.price(&token);
        std::println!(
            "{id}: price {} source {:?} ts {} divergence {:?}",
            quote.price,
            quote.source,
            quote.timestamp,
            quote.divergence_bps
        );
        assert!(quote.price > 0);
        assert_eq!(quote.source, route(&env, primary, &token).source);
        components.push_back(fund_wasm::Component {
            token,
            initial_units: 10_000_000,
        });
    }

    let fund = env.register(
        fund_wasm::WASM,
        (
            Address::generate(&env),
            Address::generate(&env),
            String::from_str(&env, "One of each"),
            String::from_str(&env, "aONE"),
            components,
            fund_wasm::Compliance::Allowlist,
        ),
    );
    env.cost_estimate().budget().reset_unlimited();
    let result = nav.nav(&fund);
    let budget = env.cost_estimate().budget();
    std::println!(
        "per share {} total {} cpu {} mem {}",
        result.per_share_usd,
        result.total_usd,
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost()
    );
    assert_eq!(result.legs.len(), 6);
    let sum: i128 = result.legs.iter().map(|leg| leg.value_usd).sum();
    assert_eq!(sum, result.per_share_usd);

    let val: Val = result.into_val(&env);
    let xdr = ScVal::try_from_val(&env, &val)
        .unwrap()
        .to_xdr_base64(Limits::none())
        .unwrap();
    std::println!("nav xdr {xdr}");
}
