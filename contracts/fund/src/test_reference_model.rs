//! Differential test against a fixed-unit basket model.
//!
//! `FixedUnitModel` is the classic in-kind basket: every share is backed by a
//! fixed amount of each component, issue charges `ceil(unit * shares)` and
//! redeem pays `floor(unit * shares)`, so rounding dust accumulates inside
//! the contract and nobody owns it.
//!
//! The Alloy fund derives units from live balances instead, so that dust
//! belongs to holders. The properties pin exactly that difference: same
//! prices up to dust, same solvency, and a fund that empties completely.
extern crate std;

use proptest::prelude::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

use crate::{Compliance, Component, Fund, FundClient, SHARE_SCALE};

struct FixedUnitModel {
    units: std::vec::Vec<i128>,
}

impl FixedUnitModel {
    fn issue_cost(&self, quantity: i128) -> std::vec::Vec<i128> {
        self.units
            .iter()
            .map(|unit| (unit * quantity + SHARE_SCALE - 1) / SHARE_SCALE)
            .collect()
    }

    fn redeem_payout(&self, quantity: i128) -> std::vec::Vec<i128> {
        self.units
            .iter()
            .map(|unit| quantity * unit / SHARE_SCALE)
            .collect()
    }
}

#[derive(Clone, Debug)]
enum Op {
    Issue { investor: usize, shares: i128 },
    Redeem { investor: usize, fraction_bps: i128 },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0usize..3, 1i128..50 * SHARE_SCALE)
            .prop_map(|(investor, shares)| Op::Issue { investor, shares }),
        (0usize..3, 1i128..=10_000).prop_map(|(investor, fraction_bps)| Op::Redeem {
            investor,
            fraction_bps
        }),
    ]
}

fn units() -> impl Strategy<Value = std::vec::Vec<i128>> {
    proptest::collection::vec(1i128..100 * SHARE_SCALE, 1..5)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn issue_and_redeem_match_the_fixed_unit_model_up_to_rounding_dust(
        initial_units in units(),
        ops in proptest::collection::vec(op(), 1..24),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().disable_resource_limits();

        let mut tokens = std::vec::Vec::new();
        let mut components = Vec::new(&env);
        for unit in &initial_units {
            let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
            components.push_back(Component { token: sac.address(), initial_units: *unit });
            tokens.push(sac.address());
        }
        let investors: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
        for token in &tokens {
            for investor in &investors {
                StellarAssetClient::new(&env, token).mint(investor, &(i128::MAX / 4));
            }
        }
        let id = env.register(
            Fund,
            (
                Address::generate(&env),
                Address::generate(&env),
                String::from_str(&env, "Parity"),
                String::from_str(&env, "PAR"),
                components,
                Compliance::Open,
            ),
        );
        let fund = FundClient::new(&env, &id);
        fund.open_for_issue();
        let model = FixedUnitModel { units: initial_units.clone() };
        let held = |i: usize| TokenClient::new(&env, &tokens[i]).balance(&id);

        for op in ops {
            match op {
                Op::Issue { investor, shares } => {
                    let supply = fund.total_supply();
                    let expected = model.issue_cost(shares);
                    let paid = fund.issue(&investors[investor], &investors[investor], &shares);
                    for (i, (p, e)) in paid.iter().zip(expected).enumerate() {
                        // Never cheaper than the model; dearer only by the dust the
                        // fund already holds above the model's units, pro rata.
                        prop_assert!(p >= e);
                        let dust = held(i) - p - supply * model.units[i] / SHARE_SCALE;
                        let dust_share = if supply == 0 { 0 } else { (dust * shares + supply - 1) / supply };
                        prop_assert!(p <= e + 1 + dust_share, "leg {}: paid {} model {} dust {}", i, p, e, dust);
                    }
                }
                Op::Redeem { investor, fraction_bps } => {
                    let balance = fund.balance(&investors[investor]);
                    let shares = balance * fraction_bps / 10_000;
                    if shares == 0 {
                        continue;
                    }
                    let supply = fund.total_supply();
                    let before: std::vec::Vec<i128> = (0..tokens.len()).map(held).collect();
                    let expected = model.redeem_payout(shares);
                    let got = fund.redeem(&investors[investor], &investors[investor], &shares, &Vec::new(&env));
                    for (i, (g, e)) in got.iter().zip(expected).enumerate() {
                        // Never less than the model pays; more only by this
                        // redeemer's pro-rata share of the dust.
                        prop_assert!(g >= e);
                        let dust = before[i] - supply * model.units[i] / SHARE_SCALE;
                        prop_assert!(g <= e + dust * shares / supply + 1);
                    }
                }
            }

            // Solvency: the fund always covers units x supply.
            let supply = fund.total_supply();
            for (i, unit) in model.units.iter().enumerate() {
                prop_assert!(held(i) * SHARE_SCALE >= supply * unit);
            }
        }

        // Where Alloy departs from the model on purpose: redeeming every share
        // empties the fund, so no dust is stranded.
        for investor in &investors {
            let balance = fund.balance(investor);
            if balance > 0 {
                fund.redeem(investor, investor, &balance, &Vec::new(&env));
            }
        }
        for i in 0..tokens.len() {
            prop_assert_eq!(held(i), 0);
        }
    }
}
