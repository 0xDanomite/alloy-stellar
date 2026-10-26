//! Fork test against real mainnet state: the live fund, the Soroswap router
//! and its pools. Ignored by default; run with
//!
//!   stellar contract build --package alloy-fund
//!   node scripts/zap-snapshot.mjs zap-mainnet.json [fund]
//!   ALLOY_ZAP_SNAPSHOT=zap-mainnet.json cargo test -p alloy-zap -- --ignored --nocapture
//!
//! The fund defaults to aLQD. The investor's USDC is minted in the fork
//! (the issuer's auth is mocked); every zap call runs with only the
//! investor's signature.
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, Vec,
};

use crate::{Zap, ZapClient};

mod fund_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/alloy_fund.wasm");
}

const ROUTER: &str = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const USDC: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ALQD: &str = "CC5QR5OOQMCPVSL3SJMH7QESCFINWUMX3427CT4NIDBS3FRVDHAM4NAJ";
const SCALE: i128 = 10_000_000;

fn report(env: &Env, what: &str) {
    let budget = env.cost_estimate().budget();
    let (cpu, mem) = (budget.cpu_instruction_cost(), budget.memory_bytes_cost());
    std::println!("{what}: cpu {cpu} mem {mem}");
    assert!(cpu < 100_000_000 && mem < 40 * 1024 * 1024);
}

#[test]
#[ignore]
fn zaps_usdc_into_and_out_of_a_mainnet_fund() {
    let path = std::env::var("ALLOY_ZAP_SNAPSHOT").expect("set ALLOY_ZAP_SNAPSHOT");
    let env = Env::from_ledger_snapshot_file(path);
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let usdc = Address::from_str(&env, USDC);
    let fund_id = Address::from_str(
        &env,
        &std::env::var("ALLOY_ZAP_FUND").unwrap_or(ALQD.into()),
    );
    let fund = fund_wasm::Client::new(&env, &fund_id);
    let zap = ZapClient::new(
        &env,
        &env.register(Zap, (Address::from_str(&env, ROUTER), usdc.clone())),
    );
    let investor = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc).mint(&investor, &(1_000 * SCALE));
    if fund.compliance() == fund_wasm::Compliance::Allowlist {
        fund.set_investor(&investor, &true);
    }

    let mut buy = Vec::new(&env);
    let mut sell = Vec::new(&env);
    for component in fund.components().iter() {
        if component.token != usdc {
            buy.push_back(soroban_sdk::vec![
                &env,
                usdc.clone(),
                component.token.clone()
            ]);
            sell.push_back(soroban_sdk::vec![
                &env,
                component.token.clone(),
                usdc.clone()
            ]);
        }
    }

    let shares = SCALE / 10;
    let max_usdc = 100 * SCALE;
    std::println!("quote_issue {:?}", fund.quote_issue(&shares));
    env.mock_auths(&[MockAuth {
        address: &investor,
        invoke: &MockAuthInvoke {
            contract: &zap.address,
            fn_name: "issue_with_usdc",
            args: (
                investor.clone(),
                fund_id.clone(),
                shares,
                max_usdc,
                buy.clone(),
            )
                .into_val(&env),
            sub_invokes: &[MockAuthInvoke {
                contract: &usdc,
                fn_name: "transfer",
                args: (investor.clone(), zap.address.clone(), max_usdc).into_val(&env),
                sub_invokes: &[],
            }],
        },
    }]);
    env.cost_estimate().budget().reset_unlimited();
    let spent = zap.issue_with_usdc(&investor, &fund_id, &shares, &max_usdc, &buy);
    report(&env, "issue_with_usdc");
    std::println!("spent {spent} USDC stroops for {shares} shares");
    assert_eq!(fund.balance(&investor), shares);

    env.mock_auths(&[MockAuth {
        address: &investor,
        invoke: &MockAuthInvoke {
            contract: &zap.address,
            fn_name: "redeem_to_usdc",
            args: (
                investor.clone(),
                fund_id.clone(),
                shares,
                0i128,
                sell.clone(),
            )
                .into_val(&env),
            sub_invokes: &[MockAuthInvoke {
                contract: &fund_id,
                fn_name: "redeem",
                args: (
                    investor.clone(),
                    zap.address.clone(),
                    shares,
                    Vec::<Address>::new(&env),
                )
                    .into_val(&env),
                sub_invokes: &[],
            }],
        },
    }]);
    env.cost_estimate().budget().reset_unlimited();
    let out = zap.redeem_to_usdc(&investor, &fund_id, &shares, &0, &sell);
    report(&env, "redeem_to_usdc");
    std::println!("redeemed {shares} shares for {out} USDC stroops");
    env.mock_all_auths();

    assert_eq!(fund.balance(&investor), 0);
    assert!(out > 0 && out <= spent);
    for component in fund.components().iter() {
        assert_eq!(
            TokenClient::new(&env, &component.token).balance(&zap.address),
            0
        );
    }
}
