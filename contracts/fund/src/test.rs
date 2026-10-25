extern crate std;

use soroban_sdk::{
    testutils::{Address as _, IssuerFlags},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, String, Vec,
};

use crate::{Compliance, Component, Fund, FundClient, FundError, SHARE_SCALE};

struct Asset<'a> {
    token: TokenClient<'a>,
    admin: StellarAssetClient<'a>,
}

fn create_asset<'a>(env: &Env, permissioned: bool) -> Asset<'a> {
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    if permissioned {
        sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    }
    Asset {
        token: TokenClient::new(env, &sac.address()),
        admin: StellarAssetClient::new(env, &sac.address()),
    }
}

struct Setup<'a> {
    env: Env,
    fund: FundClient<'a>,
    manager: Address,
    assets: std::vec::Vec<Asset<'a>>,
}

/// Units per share are in each asset's base units (7 decimals), so a share
/// starts at 1.0 of asset 0, 2.0 of asset 1, 0.5 of asset 2.
const INITIAL_UNITS: [i128; 3] = [10_000_000, 20_000_000, 5_000_000];

fn setup<'a>(compliance: Compliance, permissioned: [bool; 3]) -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let assets: std::vec::Vec<Asset> = permissioned
        .iter()
        .map(|p| create_asset(&env, *p))
        .collect();
    let mut components = Vec::new(&env);
    for (asset, units) in assets.iter().zip(INITIAL_UNITS) {
        components.push_back(Component {
            token: asset.token.address.clone(),
            initial_units: units,
        });
    }
    let platform = Address::generate(&env);
    let manager = Address::generate(&env);
    let id = env.register(
        Fund,
        (
            platform,
            manager.clone(),
            String::from_str(&env, "Alloy Stellar Treasury"),
            String::from_str(&env, "aTRSY"),
            components,
            compliance,
        ),
    );
    for (asset, p) in assets.iter().zip(permissioned) {
        if p {
            asset.admin.set_authorized(&id, &true);
        }
    }
    Setup {
        fund: FundClient::new(&env, &id),
        env,
        manager,
        assets,
    }
}

fn funded_investor(s: &Setup, amount: i128) -> Address {
    let investor = Address::generate(&s.env);
    for asset in &s.assets {
        asset.admin.set_authorized(&investor, &true);
        asset.admin.mint(&investor, &amount);
    }
    investor
}

fn balances(s: &Setup, who: &Address) -> std::vec::Vec<i128> {
    s.assets.iter().map(|a| a.token.balance(who)).collect()
}

#[test]
fn first_issue_prices_at_initial_units_and_redeem_returns_basket() {
    let s = setup(Compliance::Open, [false; 3]);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    let start = balances(&s, &investor);

    let paid = s.fund.issue(&investor, &investor, &(3 * SHARE_SCALE));
    assert_eq!(paid, vec![&s.env, 30_000_000, 60_000_000, 15_000_000]);
    assert_eq!(s.fund.balance(&investor), 3 * SHARE_SCALE);
    assert_eq!(s.fund.total_supply(), 3 * SHARE_SCALE);
    assert_eq!(
        s.fund.units_per_share(),
        vec![&s.env, 10_000_000, 20_000_000, 5_000_000]
    );

    let got = s
        .fund
        .redeem(&investor, &investor, &(3 * SHARE_SCALE), &Vec::new(&s.env));
    assert_eq!(got, paid);
    assert_eq!(balances(&s, &investor), start);
    assert_eq!(s.fund.total_supply(), 0);
}

#[test]
fn rounding_never_favors_the_caller() {
    let s = setup(Compliance::Open, [false; 3]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&a, &a, &SHARE_SCALE);

    for _ in 0..25 {
        let paid = s.fund.issue(&b, &b, &3);
        let got = s.fund.redeem(&b, &b, &3, &Vec::new(&s.env));
        for (p, g) in paid.iter().zip(got.iter()) {
            assert!(g <= p);
        }
    }
    let units = s.fund.units_per_share();
    for (u, initial) in units.iter().zip(INITIAL_UNITS) {
        assert!(u >= initial);
    }
}

#[test]
fn second_issue_tracks_live_holdings_after_donation() {
    let s = setup(Compliance::Open, [false; 3]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&a, &a, &SHARE_SCALE);

    s.assets[0].admin.mint(&s.fund.address, &SHARE_SCALE);
    assert_eq!(s.fund.units_per_share().get_unchecked(0), 2 * SHARE_SCALE);

    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    let paid = s.fund.issue(&b, &b, &SHARE_SCALE);
    assert_eq!(paid.get_unchecked(0), 2 * SHARE_SCALE);
}

#[test]
fn clawback_lowers_value_per_share_and_redeem_stays_pro_rata() {
    let s = setup(Compliance::Allowlist, [false, false, true]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.set_investor(&a, &true);
    s.fund.set_investor(&b, &true);
    s.fund.issue(&a, &a, &(2 * SHARE_SCALE));
    s.fund.issue(&b, &b, &(2 * SHARE_SCALE));

    let held = s.assets[2].token.balance(&s.fund.address);
    s.assets[2].admin.clawback(&s.fund.address, &(held / 2));

    assert_eq!(
        s.fund.units_per_share().get_unchecked(2),
        INITIAL_UNITS[2] / 2
    );
    let none = Vec::new(&s.env);
    let got = s.fund.redeem(&a, &a, &(2 * SHARE_SCALE), &none);
    assert_eq!(got, vec![&s.env, 20_000_000, 40_000_000, 5_000_000]);
    let got = s.fund.redeem(&b, &b, &(2 * SHARE_SCALE), &none);
    assert_eq!(got, vec![&s.env, 20_000_000, 40_000_000, 5_000_000]);
    assert_eq!(s.fund.holdings(), vec![&s.env, 0, 0, 0]);
}

#[test]
fn unauthorized_fund_cannot_receive_permissioned_asset() {
    let s = setup(Compliance::Open, [false, false, true]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.assets[2].admin.set_authorized(&s.fund.address, &false);
    assert!(s.fund.try_issue(&a, &a, &SHARE_SCALE).is_err());
}

#[test]
fn frozen_leg_can_be_skipped_and_claimed_later() {
    let s = setup(Compliance::Open, [false, false, true]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&a, &a, &SHARE_SCALE);
    s.fund.issue(&b, &b, &SHARE_SCALE);

    s.assets[2].admin.set_authorized(&a, &false);
    let none = Vec::new(&s.env);
    assert!(s.fund.try_redeem(&a, &a, &SHARE_SCALE, &none).is_err());

    let skip = vec![&s.env, s.assets[2].token.address.clone()];
    s.fund.redeem(&a, &a, &SHARE_SCALE, &skip);
    assert_eq!(
        s.fund.owed(&a, &s.assets[2].token.address),
        INITIAL_UNITS[2]
    );
    assert_eq!(
        s.fund.units_per_share(),
        vec![&s.env, 10_000_000, 20_000_000, 5_000_000]
    );

    s.assets[2].admin.set_authorized(&a, &true);
    let before = s.assets[2].token.balance(&a);
    s.fund.withdraw_owed(&a, &a, &s.assets[2].token.address);
    assert_eq!(s.assets[2].token.balance(&a) - before, INITIAL_UNITS[2]);
    assert_eq!(s.fund.owed(&a, &s.assets[2].token.address), 0);
}

#[test]
fn redeem_works_whatever_the_manager_does() {
    let s = setup(Compliance::Allowlist, [false; 3]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.set_investor(&a, &true);
    s.fund.issue(&a, &a, &SHARE_SCALE);

    s.fund.set_investor(&a, &false);
    let hostile = Address::generate(&s.env);
    s.fund.set_manager(&hostile);

    s.fund.redeem(&a, &a, &SHARE_SCALE, &Vec::new(&s.env));
    assert_eq!(s.fund.balance(&a), 0);
}

#[test]
fn allowlist_gates_issue_and_transfer_but_not_redeem() {
    let s = setup(Compliance::Allowlist, [false; 3]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let outsider = Address::generate(&s.env);

    assert_eq!(
        s.fund.try_issue(&a, &a, &SHARE_SCALE),
        Err(Ok(FundError::NotAllowlisted.into()))
    );
    s.fund.set_investor(&a, &true);
    s.fund.issue(&a, &a, &SHARE_SCALE);
    assert_eq!(
        s.fund.try_transfer(&a, &outsider, &1),
        Err(Ok(FundError::NotAllowlisted.into()))
    );
    s.fund.set_compliance(&Compliance::Open);
    s.fund.transfer(&a, &outsider, &1);
    assert_eq!(s.fund.balance(&outsider), 1);
}

#[test]
fn manager_actions_require_manager_auth() {
    let s = setup(Compliance::Allowlist, [false; 3]);
    let a = Address::generate(&s.env);
    s.fund.set_investor(&a, &true);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.manager);
}

#[test]
fn transfer_from_spends_allowance() {
    let s = setup(Compliance::Open, [false; 3]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let spender = Address::generate(&s.env);
    let to = Address::generate(&s.env);
    s.fund.issue(&a, &a, &SHARE_SCALE);
    let expiry = s.env.ledger().sequence() + 100;
    s.fund.approve(&a, &spender, &500, &expiry);
    s.fund.transfer_from(&spender, &a, &to, &400);
    assert_eq!(s.fund.allowance(&a, &spender), 100);
    assert_eq!(
        s.fund.try_transfer_from(&spender, &a, &to, &101),
        Err(Ok(FundError::InsufficientAllowance.into()))
    );
}

#[test]
#[should_panic]
fn rejects_duplicate_components() {
    let env = Env::default();
    let asset = create_asset(&env, false);
    let name = String::from_str(&env, "x");
    let dup = vec![
        &env,
        Component {
            token: asset.token.address.clone(),
            initial_units: 1,
        },
        Component {
            token: asset.token.address.clone(),
            initial_units: 1,
        },
    ];
    env.register(
        Fund,
        (
            Address::generate(&env),
            Address::generate(&env),
            name.clone(),
            name,
            dup,
            Compliance::Open,
        ),
    );
}

#[test]
fn twelve_component_issue_and_redeem_fit_mainnet_limits() {
    let env = Env::default();
    env.mock_all_auths();
    let investor = Address::generate(&env);
    let mut components = Vec::new(&env);
    let mut assets = std::vec::Vec::new();
    for _ in 0..crate::MAX_COMPONENTS {
        let asset = create_asset(&env, false);
        asset.admin.mint(&investor, &(1_000 * SHARE_SCALE));
        components.push_back(Component {
            token: asset.token.address.clone(),
            initial_units: SHARE_SCALE,
        });
        assets.push(asset);
    }
    let id = env.register(
        Fund,
        (
            Address::generate(&env),
            Address::generate(&env),
            String::from_str(&env, "Wide"),
            String::from_str(&env, "WIDE"),
            components,
            Compliance::Open,
        ),
    );
    let fund = FundClient::new(&env, &id);
    fund.issue(&investor, &investor, &SHARE_SCALE);
    std::println!("issue x12: {:?}", env.cost_estimate().resources());
    fund.redeem(&investor, &investor, &SHARE_SCALE, &Vec::new(&env));
    std::println!("redeem x12: {:?}", env.cost_estimate().resources());
    assert_eq!(assets[11].token.balance(&investor), 1_000 * SHARE_SCALE);
}

#[test]
fn clawback_below_owed_reserve_never_blocks_redeem() {
    let s = setup(Compliance::Open, [false, false, true]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&a, &a, &SHARE_SCALE);
    s.fund.issue(&b, &b, &SHARE_SCALE);
    let leg = s.assets[2].token.address.clone();

    s.fund
        .redeem(&a, &a, &SHARE_SCALE, &vec![&s.env, leg.clone()]);
    // Issuer claws back almost everything, cutting into a's reserved claim.
    let held = s.assets[2].token.balance(&s.fund.address);
    s.assets[2]
        .admin
        .clawback(&s.fund.address, &(held - 1_000_000));

    assert_eq!(s.fund.holdings().get_unchecked(2), 0);
    let got = s.fund.redeem(&b, &b, &SHARE_SCALE, &Vec::new(&s.env));
    assert_eq!(got, vec![&s.env, 10_000_000, 20_000_000, 0]);

    assert_eq!(s.fund.withdraw_owed(&a, &a, &leg), 1_000_000);
    assert_eq!(s.fund.owed(&a, &leg), INITIAL_UNITS[2] - 1_000_000);
}
