extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Symbol, Vec,
};

use crate::{
    Compliance, Component, Fund, FundClient, FundError, Mandate, PriceQuote, ShelfStatus,
    SHARE_SCALE, YEAR_SECONDS,
};

/// Classes every token Open except the ones stored under "perm" and "unl".
#[contract]
struct MockPlatform;

#[contractimpl]
impl MockPlatform {
    pub fn set_permissioned(env: Env, token: Address) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("perm"), &token);
    }

    pub fn admin(env: Env) -> Address {
        env.current_contract_address()
    }

    pub fn set_unlisted(env: Env, token: Address) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("unl"), &token);
    }

    pub fn shelf_status(env: Env, token: Address) -> ShelfStatus {
        let instance = env.storage().instance();
        let perm: Option<Address> = instance.get(&soroban_sdk::symbol_short!("perm"));
        let unlisted: Option<Address> = instance.get(&soroban_sdk::symbol_short!("unl"));
        if perm == Some(token.clone()) {
            ShelfStatus::Permissioned
        } else if unlisted == Some(token) {
            ShelfStatus::Unlisted
        } else {
            ShelfStatus::Open
        }
    }
}

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

/// A fund open for issue, as most tests want it.
fn setup<'a>(compliance: Compliance, permissioned: [bool; 3]) -> Setup<'a> {
    let s = setup_closed(compliance, permissioned);
    s.fund.open_for_issue();
    s
}

/// A fund still in setup: fee and mandate settable, `issue` refused.
fn setup_closed<'a>(compliance: Compliance, permissioned: [bool; 3]) -> Setup<'a> {
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
    let platform = env.register(MockPlatform, ());
    for (asset, p) in assets.iter().zip(permissioned) {
        if p {
            MockPlatformClient::new(&env, &platform).set_permissioned(&asset.token.address);
        }
    }
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

fn managed<'a>(compliance: Compliance) -> Setup<'a> {
    let s = setup_closed(compliance, [false; 3]);
    s.fund.set_mandate(&Mandate::Managed);
    s.fund.open_for_issue();
    s
}

/// A closed fund with a fee set, then opened.
fn with_fee<'a>(compliance: Compliance, rate_bps: u32) -> Setup<'a> {
    let s = setup_closed(compliance, [false; 3]);
    s.fund.init_fee(&rate_bps);
    s.fund.open_for_issue();
    s
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
    env.mock_all_auths();
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
    env.cost_estimate().disable_resource_limits();
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
    fund.open_for_issue();
    // Limits are disabled because the test harness records auth inside the
    // same budget; the asserts below hold the contract to a tenth of the
    // mainnet caps (100M instructions, 200 write entries) instead.
    fund.issue(&investor, &investor, &SHARE_SCALE);
    let issue = env.cost_estimate().resources();
    fund.redeem(&investor, &investor, &SHARE_SCALE, &Vec::new(&env));
    let redeem = env.cost_estimate().resources();
    for cost in [issue, redeem] {
        assert!(cost.instructions < 10_000_000, "{:?}", cost);
        assert!(cost.write_entries < 40, "{:?}", cost);
    }
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

#[test]
fn manager_cannot_open_a_fund_holding_a_permissioned_asset() {
    let s = setup(Compliance::Allowlist, [false, false, true]);
    assert_eq!(
        s.fund.try_set_compliance(&Compliance::Open),
        Err(Ok(FundError::PermissionedComponent.into()))
    );
    assert_eq!(s.fund.compliance(), Compliance::Allowlist);
}

#[test]
fn issue_is_blocked_while_a_leg_is_short_of_owed_claims() {
    let s = setup(Compliance::Open, [false, false, true]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&a, &a, &SHARE_SCALE);
    s.fund.issue(&b, &b, &SHARE_SCALE);
    let leg = s.assets[2].token.address.clone();
    s.fund
        .redeem(&a, &a, &SHARE_SCALE, &vec![&s.env, leg.clone()]);
    let held = s.assets[2].token.balance(&s.fund.address);
    s.assets[2].admin.clawback(&s.fund.address, &(held - 1));
    assert_eq!(
        s.fund.try_issue(&b, &b, &SHARE_SCALE),
        Err(Ok(FundError::ReserveShortfall.into()))
    );
}

#[test]
fn leftovers_in_an_empty_fund_go_to_the_manager_not_the_next_investor() {
    let s = setup(Compliance::Open, [false; 3]);
    let alice = funded_investor(&s, 1_000 * SHARE_SCALE);
    let bob = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&alice, &alice, &(10 * SHARE_SCALE));
    s.fund.burn(&alice, &(10 * SHARE_SCALE));

    let paid = s.fund.issue(&bob, &bob, &1);
    assert_eq!(paid, vec![&s.env, 1, 2, 1]);
    let got = s.fund.redeem(&bob, &bob, &1, &Vec::new(&s.env));
    for (g, p) in got.iter().zip(paid.iter()) {
        assert!(g <= p);
    }
    for (asset, units) in s.assets.iter().zip(INITIAL_UNITS) {
        assert_eq!(s.fund.owed(&s.manager, &asset.token.address), 10 * units);
    }
    s.fund
        .withdraw_owed(&s.manager, &s.manager, &s.assets[0].token.address);
    assert_eq!(s.assets[0].token.balance(&s.manager), 10 * INITIAL_UNITS[0]);
}

#[test]
fn approve_rejects_expiry_beyond_max_ttl() {
    let s = setup(Compliance::Open, [false; 3]);
    let a = Address::generate(&s.env);
    let spender = Address::generate(&s.env);
    let too_far = s.env.ledger().sequence() + s.env.storage().max_ttl() + 1;
    assert_eq!(
        s.fund.try_approve(&a, &spender, &1, &too_far),
        Err(Ok(FundError::InvalidExpiration.into()))
    );
}

/// Every token is worth $1 unless `set` says otherwise, quoted fresh from
/// its primary and confirmed by a fresh second source at zero divergence
/// unless `set_quality`, `set_readings` or `set_fallback` say otherwise. A
/// quote with no divergence has no second reading, as NAV reports it.
#[contract]
struct MockNav;

#[contractimpl]
impl MockNav {
    pub fn set(env: Env, token: Address, price: i128) {
        env.storage().instance().set(&token, &price);
    }

    pub fn set_fallback(env: Env, token: Address, fallback: bool) {
        env.storage()
            .instance()
            .set(&(token, soroban_sdk::symbol_short!("fb")), &fallback);
    }

    pub fn set_quality(env: Env, token: Address, age_secs: u64, divergence_bps: Option<u32>) {
        Self::set_readings(env, token, age_secs, divergence_bps, 0);
    }

    pub fn set_readings(
        env: Env,
        token: Address,
        age_secs: u64,
        divergence_bps: Option<u32>,
        secondary_age_secs: u64,
    ) {
        env.storage().instance().set(
            &(token, soroban_sdk::symbol_short!("q")),
            &(age_secs, divergence_bps, secondary_age_secs),
        );
    }

    pub fn price(env: Env, token: Address) -> PriceQuote {
        let instance = env.storage().instance();
        let (age, divergence_bps, secondary_age): (u64, Option<u32>, u64) = instance
            .get(&(token.clone(), soroban_sdk::symbol_short!("q")))
            .unwrap_or((0, Some(0), 0));
        let now = env.ledger().timestamp();
        let fallback: bool = instance
            .get(&(token.clone(), soroban_sdk::symbol_short!("fb")))
            .unwrap_or(false);
        PriceQuote {
            price: instance.get(&token).unwrap_or(100_000_000),
            timestamp: now - age,
            source: soroban_sdk::symbol_short!("mock"),
            divergence_bps,
            secondary_timestamp: divergence_bps.map(|_| now - secondary_age),
            from_primary: !fallback,
        }
    }
}

fn with_oracle<'a>(s: &'a Setup<'a>) -> MockNavClient<'a> {
    let nav = s.env.register(MockNav, ());
    s.fund.set_nav(&nav);
    MockNavClient::new(&s.env, &nav)
}

#[test]
fn rebalance_reweights_every_share_within_the_oracle_bound() {
    let s = setup(Compliance::Open, [false; 3]);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);

    let (sell, buy) = (&s.assets[1].token, &s.assets[0].token);
    s.assets[0].admin.mint(&s.manager, &(5 * SHARE_SCALE));
    // 5.0 of asset 1 out, 4.96 of asset 0 in: a 0.8% haircut, inside the 1% bound.
    s.fund
        .rebalance(&sell.address, &(5 * SHARE_SCALE), &buy.address, &49_600_000);

    let units = s.fund.units_per_share();
    assert_eq!(units.get(0), Some(14_960_000));
    assert_eq!(units.get(1), Some(15_000_000));
    assert_eq!(sell.balance(&s.manager), 5 * SHARE_SCALE);

    let before = balances(&s, &investor);
    s.fund
        .redeem(&investor, &investor, &(10 * SHARE_SCALE), &Vec::new(&s.env));
    let after = balances(&s, &investor);
    assert_eq!(after[0] - before[0], 149_600_000);
    assert_eq!(after[1] - before[1], 150_000_000);
}

#[test]
fn rebalance_rejects_a_fill_worse_than_the_oracle_bound() {
    let s = setup(Compliance::Open, [false; 3]);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    let nav = with_oracle(&s);
    nav.set(&s.assets[0].token.address, &200_000_000);

    s.assets[1].admin.mint(&s.manager, &(10 * SHARE_SCALE));
    // 1.0 of asset 0 ($2) out for 1.9 of asset 1 ($1.90): a 5% loss.
    let result = s.fund.try_rebalance(
        &s.assets[0].token.address,
        &SHARE_SCALE,
        &s.assets[1].token.address,
        &19_000_000,
    );
    assert_eq!(result, Err(Ok(FundError::PriceTooLow.into())));
    let ok = s.fund.try_rebalance(
        &s.assets[0].token.address,
        &SHARE_SCALE,
        &s.assets[1].token.address,
        &19_900_000,
    );
    assert!(ok.is_ok());
}

#[test]
fn rebalance_needs_an_admin_set_oracle_and_known_components() {
    let s = setup(Compliance::Open, [false; 3]);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    // A mainnet build falls back to the compiled NAV contract instead.
    #[cfg(not(feature = "mainnet"))]
    assert_eq!(
        s.fund.try_rebalance(a, &SHARE_SCALE, b, &SHARE_SCALE),
        Err(Ok(FundError::NoOracle.into()))
    );

    with_oracle(&s);
    let stranger = create_asset(&s.env, false);
    assert_eq!(
        s.fund
            .try_rebalance(a, &SHARE_SCALE, &stranger.token.address, &SHARE_SCALE),
        Err(Ok(FundError::UnknownComponent.into()))
    );
    assert_eq!(
        s.fund.try_rebalance(a, &SHARE_SCALE, a, &SHARE_SCALE),
        Err(Ok(FundError::SameComponent.into()))
    );
    assert_eq!(
        s.fund
            .try_rebalance(a, &(100 * SHARE_SCALE), b, &(100 * SHARE_SCALE)),
        Err(Ok(FundError::InsufficientBalance.into()))
    );
}

fn at(s: &Setup, timestamp: u64) {
    s.env.ledger().set_timestamp(timestamp);
}

#[test]
fn fee_streams_as_new_shares_split_with_the_platform() {
    let s = with_fee(Compliance::Open, 200);
    let platform_cut = Address::generate(&s.env);
    s.fund.set_platform_fee(&2_000, &platform_cut);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(100 * SHARE_SCALE));

    at(&s, YEAR_SECONDS);
    assert_eq!(s.fund.pending_fee(), 20_408_163);
    assert_eq!(s.fund.accrue_fee(), 20_408_163);
    assert_eq!(s.fund.balance(&platform_cut), 4_081_632);
    assert_eq!(s.fund.balance(&s.manager), 16_326_531);
    assert_eq!(s.fund.accrue_fee(), 0);

    // A year at 2% leaves the holder 98% of the basket.
    let got = s.fund.redeem(
        &investor,
        &investor,
        &(100 * SHARE_SCALE),
        &Vec::new(&s.env),
    );
    assert_eq!(got.get_unchecked(0), 980_000_000);
}

#[test]
fn quotes_include_the_fee_that_issue_and_redeem_accrue_first() {
    let s = with_fee(Compliance::Open, 100);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(50 * SHARE_SCALE));

    at(&s, YEAR_SECONDS / 2);
    let quoted = s.fund.quote_redeem(&(10 * SHARE_SCALE));
    let got = s
        .fund
        .redeem(&investor, &investor, &(10 * SHARE_SCALE), &Vec::new(&s.env));
    assert_eq!(got, quoted);
    assert!(s.fund.balance(&s.manager) > 0);

    at(&s, YEAR_SECONDS);
    let quoted = s.fund.quote_issue(&SHARE_SCALE);
    assert_eq!(s.fund.issue(&investor, &investor, &SHARE_SCALE), quoted);
}

#[test]
fn fee_accrual_never_blocks_a_redemption() {
    let s = with_fee(Compliance::Allowlist, crate::MAX_FEE_BPS);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.set_investor(&investor, &true);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    s.fund.set_investor(&investor, &false);

    at(&s, 100 * YEAR_SECONDS);
    s.fund
        .redeem(&investor, &investor, &(10 * SHARE_SCALE), &Vec::new(&s.env));
    // Capped at one year per accrual: 5% / 95% of supply. The manager is
    // not on the allowlist, so the fund holds the shares for it.
    assert_eq!(s.fund.fee_escrow(&s.manager), 5_263_157);
    assert_eq!(s.fund.balance(&s.manager), 0);
}

#[test]
fn fee_is_set_once_before_issue_opens_and_capped() {
    let s = setup_closed(Compliance::Open, [false; 3]);
    assert_eq!(
        s.fund.try_init_fee(&(crate::MAX_FEE_BPS + 1)),
        Err(Ok(FundError::FeeTooHigh.into()))
    );
    s.fund.init_fee(&50);
    assert_eq!(s.env.auths()[0].0, s.manager);
    assert_eq!(
        s.fund.try_init_fee(&50),
        Err(Ok(FundError::FeeAlreadySet.into()))
    );
    assert_eq!(s.fund.fee().unwrap().rate_bps, 50);

    let late = setup(Compliance::Open, [false; 3]);
    assert_eq!(
        late.fund.try_init_fee(&50),
        Err(Ok(FundError::IssuanceOpen.into()))
    );
}

#[test]
fn platform_cut_is_admin_only_and_capped_at_half() {
    let s = setup(Compliance::Open, [false; 3]);
    let to = Address::generate(&s.env);
    assert_eq!(
        s.fund
            .try_set_platform_fee(&(crate::MAX_PLATFORM_SHARE_BPS + 1), &to),
        Err(Ok(FundError::ShareTooHigh.into()))
    );
    s.fund.set_platform_fee(&crate::MAX_PLATFORM_SHARE_BPS, &to);
    assert_eq!(s.env.auths()[0].0, s.fund.platform());
    assert_eq!(s.fund.platform_fee().unwrap().recipient, to);
}

#[test]
fn fee_recipient_change_settles_the_old_recipient_first() {
    let s = with_fee(Compliance::Open, 100);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    at(&s, YEAR_SECONDS);
    let treasury = Address::generate(&s.env);
    s.fund.set_fee_recipient(&treasury);
    assert!(s.fund.balance(&s.manager) > 0);
    assert_eq!(s.fund.balance(&treasury), 0);
    assert_eq!(s.fund.fee_recipient(), treasury);

    at(&s, 2 * YEAR_SECONDS);
    s.fund.accrue_fee();
    assert!(s.fund.balance(&treasury) > 0);
}

#[test]
fn a_locked_fund_rebalances_but_never_changes_its_components() {
    let s = setup(Compliance::Open, [false; 3]);
    assert_eq!(s.fund.mandate(), Mandate::Locked);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    s.assets[1].admin.mint(&s.manager, &SHARE_SCALE);
    s.fund.rebalance(a, &SHARE_SCALE, b, &SHARE_SCALE);
    assert_eq!(s.fund.holdings().get_unchecked(1), 210_000_000);
    let extra = create_asset(&s.env, false);
    assert_eq!(
        s.fund.try_add_component(&extra.token.address),
        Err(Ok(FundError::MandateLocked.into()))
    );
    assert_eq!(
        s.fund.try_set_mandate(&Mandate::Managed),
        Err(Ok(FundError::IssuanceOpen.into()))
    );

    let fresh = setup_closed(Compliance::Open, [false; 3]);
    fresh.fund.set_mandate(&Mandate::Managed);
    assert_eq!(
        fresh.fund.try_set_mandate(&Mandate::Locked),
        Err(Ok(FundError::MandateFixed.into()))
    );
}

#[test]
fn managed_fund_adds_shelf_assets_and_rebalances_into_them() {
    let s = managed(Compliance::Open);
    let platform = MockPlatformClient::new(&s.env, &s.fund.platform());

    let unlisted = create_asset(&s.env, false);
    platform.set_unlisted(&unlisted.token.address);
    assert_eq!(
        s.fund.try_add_component(&unlisted.token.address),
        Err(Ok(FundError::NotOnShelf.into()))
    );
    let gated = create_asset(&s.env, true);
    platform.set_permissioned(&gated.token.address);
    assert_eq!(
        s.fund.try_add_component(&gated.token.address),
        Err(Ok(FundError::PermissionedComponent.into()))
    );
    assert_eq!(
        s.fund.try_add_component(&s.assets[0].token.address),
        Err(Ok(FundError::DuplicateComponent.into()))
    );

    let extra = create_asset(&s.env, false);
    s.fund.add_component(&extra.token.address);
    assert_eq!(s.fund.components().len(), 4);

    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    let paid = s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    assert_eq!(paid.get_unchecked(3), 0);

    with_oracle(&s);
    extra.admin.mint(&s.manager, &(5 * SHARE_SCALE));
    s.fund.rebalance(
        &s.assets[0].token.address,
        &(5 * SHARE_SCALE),
        &extra.token.address,
        &(5 * SHARE_SCALE),
    );
    assert_eq!(s.fund.units_per_share().get_unchecked(3), 5_000_000);
    let got = s
        .fund
        .redeem(&investor, &investor, &(10 * SHARE_SCALE), &Vec::new(&s.env));
    assert_eq!(got.get_unchecked(3), 5 * SHARE_SCALE);

    for _ in 4..crate::MAX_COMPONENTS {
        s.fund
            .add_component(&create_asset(&s.env, false).token.address);
    }
    assert_eq!(
        s.fund
            .try_add_component(&create_asset(&s.env, false).token.address),
        Err(Ok(FundError::TooManyComponents.into()))
    );
}

#[test]
fn rebalances_are_a_minute_apart() {
    let s = managed(Compliance::Open);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    s.assets[0].admin.mint(&s.manager, &(10 * SHARE_SCALE));
    let (sell, buy) = (&s.assets[1].token.address, &s.assets[0].token.address);

    at(&s, 1_000);
    s.fund.rebalance(sell, &SHARE_SCALE, buy, &SHARE_SCALE);
    assert_eq!(s.fund.last_rebalance(), Some(1_000));
    at(&s, 1_059);
    assert_eq!(
        s.fund.try_rebalance(sell, &SHARE_SCALE, buy, &SHARE_SCALE),
        Err(Ok(FundError::RebalanceCooldown.into()))
    );
    at(&s, 1_060);
    s.fund.rebalance(sell, &SHARE_SCALE, buy, &SHARE_SCALE);
}

#[test]
fn losses_inside_a_day_are_capped_at_two_percent_of_fund_value() {
    let s = managed(Compliance::Open);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    for asset in &s.assets[..2] {
        asset.admin.mint(&s.manager, &(100 * SHARE_SCALE));
    }
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);

    // Each trade gives up $0.04 of a ~$35 fund, about 11.4 bps.
    let mut now = 0;
    let mut accepted = 0;
    let refused = loop {
        now += 60;
        at(&s, now);
        let (sell, buy) = if accepted % 2 == 0 { (b, a) } else { (a, b) };
        match s.fund.try_rebalance(sell, &50_000_000, buy, &49_600_000) {
            Ok(_) => accepted += 1,
            Err(error) => break error,
        }
        assert!(accepted < 32);
    };
    assert_eq!(refused, Ok(FundError::LossBudgetExceeded.into()));
    assert_eq!(accepted, 17);
    let used = s.fund.window_loss_ppb();
    assert!(used <= crate::MAX_WINDOW_LOSS_BPS * 100_000);
    assert!(used > 19_000_000);

    // Gains are free, and the oldest losses age out of the window.
    s.fund.rebalance(b, &50_000_000, a, &50_000_000);
    at(&s, 60 + crate::LOSS_WINDOW_SECONDS);
    assert!(s.fund.window_loss_ppb() < used);
    s.fund.rebalance(b, &50_000_000, a, &49_600_000);
}

#[test]
fn rebalance_refuses_a_non_positive_oracle_price() {
    let s = managed(Compliance::Open);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    let nav = with_oracle(&s);
    nav.set(&s.assets[1].token.address, &0);
    s.assets[1].admin.mint(&s.manager, &(10 * SHARE_SCALE));
    assert_eq!(
        s.fund.try_rebalance(
            &s.assets[0].token.address,
            &SHARE_SCALE,
            &s.assets[1].token.address,
            &(10 * SHARE_SCALE),
        ),
        Err(Ok(FundError::BadPrice.into()))
    );
}

#[test]
fn metadata_is_manager_written_and_bounded() {
    let s = setup(Compliance::Open, [false; 3]);
    let description = Symbol::new(&s.env, "description");
    let website = Symbol::new(&s.env, "website");
    s.fund.set_metadata(
        &description,
        &String::from_str(&s.env, "Short-dated treasuries, rebalanced monthly"),
    );
    assert_eq!(s.env.auths()[0].0, s.manager);
    s.fund
        .set_metadata(&website, &String::from_str(&s.env, "https://example.com"));
    assert_eq!(s.fund.metadata().len(), 2);
    s.fund.set_metadata(&website, &String::from_str(&s.env, ""));
    assert_eq!(s.fund.metadata().keys(), vec![&s.env, description]);

    let long = String::from_str(&s.env, &"x".repeat(crate::MAX_METADATA_BYTES as usize + 1));
    assert_eq!(
        s.fund
            .try_set_metadata(&Symbol::new(&s.env, "strategy"), &long),
        Err(Ok(FundError::MetadataTooLarge.into()))
    );
    for i in 1..crate::MAX_METADATA_ENTRIES {
        let key = Symbol::new(&s.env, &std::format!("k{i}"));
        s.fund.set_metadata(&key, &String::from_str(&s.env, "v"));
    }
    assert_eq!(
        s.fund.try_set_metadata(
            &Symbol::new(&s.env, "one_more"),
            &String::from_str(&s.env, "v")
        ),
        Err(Ok(FundError::MetadataTooLarge.into()))
    );
}

#[test]
fn nav_falls_back_to_the_compiled_network_default() {
    let s = setup(Compliance::Open, [false; 3]);
    #[cfg(not(feature = "mainnet"))]
    assert_eq!(s.fund.nav(), None);
    #[cfg(feature = "mainnet")]
    assert_eq!(
        s.fund.nav(),
        Some(Address::from_str(
            &s.env,
            "CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC"
        ))
    );
    let nav = with_oracle(&s);
    assert_eq!(s.fund.nav(), Some(nav.address));
}

#[test]
fn nobody_can_issue_before_the_manager_opens_the_fund() {
    let s = setup_closed(Compliance::Open, [false; 3]);
    let early = funded_investor(&s, 1_000 * SHARE_SCALE);
    assert!(!s.fund.is_open());
    assert_eq!(
        s.fund.try_issue(&early, &early, &SHARE_SCALE),
        Err(Ok(FundError::IssuanceClosed.into()))
    );
    // The manager can still configure, then opens.
    s.fund.init_fee(&100);
    s.fund.set_mandate(&Mandate::Managed);
    s.fund.open_for_issue();
    assert_eq!(s.env.auths()[0].0, s.manager);
    assert_eq!(
        s.fund.try_open_for_issue(),
        Err(Ok(FundError::IssuanceOpen.into()))
    );
    s.fund.issue(&early, &early, &SHARE_SCALE);
    assert_eq!(s.fund.balance(&early), SHARE_SCALE);
}

#[test]
fn fee_recipients_must_pass_the_allowlist() {
    let s = with_fee(Compliance::Allowlist, 100);
    let outsider = Address::generate(&s.env);
    assert_eq!(
        s.fund.try_set_fee_recipient(&outsider),
        Err(Ok(FundError::NotAllowlisted.into()))
    );
    assert_eq!(
        s.fund.try_set_platform_fee(&1_000, &outsider),
        Err(Ok(FundError::NotAllowlisted.into()))
    );
}

#[test]
fn fee_for_a_recipient_off_the_allowlist_waits_in_escrow() {
    let s = with_fee(Compliance::Allowlist, 100);
    let platform_cut = Address::generate(&s.env);
    s.fund.set_investor(&platform_cut, &true);
    s.fund.set_platform_fee(&5_000, &platform_cut);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.set_investor(&investor, &true);
    s.fund.issue(&investor, &investor, &(99 * SHARE_SCALE));

    // The manager, the default recipient, was never allowlisted, and the
    // platform recipient is removed before the fee accrues.
    s.fund.set_investor(&platform_cut, &false);
    at(&s, YEAR_SECONDS);
    let minted = s.fund.accrue_fee();
    assert_eq!(minted, 10_000_000);
    assert_eq!(s.fund.balance(&s.manager), 0);
    assert_eq!(s.fund.balance(&platform_cut), 0);
    assert_eq!(s.fund.fee_escrow(&s.manager), 5_000_000);
    assert_eq!(s.fund.fee_escrow(&platform_cut), 5_000_000);
    assert_eq!(s.fund.balance(&s.fund.address), minted);
    assert_eq!(s.fund.total_supply(), 100 * SHARE_SCALE);

    assert_eq!(
        s.fund.try_claim_fee(&s.manager),
        Err(Ok(FundError::NotAllowlisted.into()))
    );
    s.fund.set_investor(&s.manager, &true);
    assert_eq!(s.fund.claim_fee(&s.manager), 5_000_000);
    assert_eq!(s.fund.balance(&s.manager), 5_000_000);
    assert_eq!(s.fund.fee_escrow(&s.manager), 0);
    assert_eq!(s.fund.balance(&s.fund.address), 5_000_000);
}

/// A one-pool stand-in for the Soroswap router with the same call shape:
/// it requires `to`'s auth, pulls `amount_in` of `path[0]` from `to` into
/// the pool (itself), and pays `amount_in * rate / 10_000` of the last token.
/// `skim` pays half and ignores the minimum; `greedy` pulls one unit extra.
#[contract]
struct MockRouter;

#[contractimpl]
impl MockRouter {
    pub fn configure(env: Env, rate_bps: i128, skim: bool, greedy: bool) {
        let instance = env.storage().instance();
        instance.set(&soroban_sdk::symbol_short!("rate"), &rate_bps);
        instance.set(&soroban_sdk::symbol_short!("skim"), &skim);
        instance.set(&soroban_sdk::symbol_short!("greedy"), &greedy);
    }

    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        assert!(env.ledger().timestamp() < deadline, "deadline expired");
        let instance = env.storage().instance();
        let rate: i128 = instance
            .get(&soroban_sdk::symbol_short!("rate"))
            .unwrap_or(10_000);
        let skim: bool = instance
            .get(&soroban_sdk::symbol_short!("skim"))
            .unwrap_or(false);
        let greedy: bool = instance
            .get(&soroban_sdk::symbol_short!("greedy"))
            .unwrap_or(false);
        let out = amount_in * rate / 10_000;
        assert!(skim || out >= amount_out_min, "insufficient output amount");
        let pool = env.current_contract_address();
        let pulled = if greedy { amount_in + 1 } else { amount_in };
        TokenClient::new(&env, &path.first_unchecked()).transfer(&to, &pool, &pulled);
        let paid = if skim { out / 2 } else { out };
        TokenClient::new(&env, &path.last_unchecked()).transfer(&pool, &to, &paid);
        vec![&env, amount_in, paid]
    }
}

fn with_router<'a>(s: &'a Setup<'a>, rate_bps: i128) -> MockRouterClient<'a> {
    let id = s.env.register(MockRouter, ());
    let router = MockRouterClient::new(&s.env, &id);
    router.configure(&rate_bps, &false, &false);
    for asset in &s.assets {
        asset.admin.mint(&id, &(1_000 * SHARE_SCALE));
    }
    s.fund.set_router(&id);
    router
}

/// A managed fund holding 10 shares (10, 20 and 5 of the three assets at
/// $1 each) with an oracle set.
fn trading_fund<'a>() -> Setup<'a> {
    let s = managed(Compliance::Open);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    s
}

fn route(s: &Setup, from: usize, to: usize) -> Vec<Address> {
    vec![
        &s.env,
        s.assets[from].token.address.clone(),
        s.assets[to].token.address.clone(),
    ]
}

#[test]
fn trade_swaps_through_the_router_with_the_fund_as_trader() {
    let s = trading_fund();
    with_router(&s, 9_950);
    let (sell, buy) = (&s.assets[1].token.address, &s.assets[0].token.address);

    // Only the manager signs; the fund authorizes its own input transfer.
    let path = route(&s, 1, 0);
    s.env.mock_auths(&[MockAuth {
        address: &s.manager,
        invoke: &MockAuthInvoke {
            contract: &s.fund.address,
            fn_name: "trade",
            args: (sell, 5 * SHARE_SCALE, buy, 0i128, path.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    let bought = s.fund.trade(sell, &(5 * SHARE_SCALE), buy, &0, &path);

    assert_eq!(bought, 49_750_000);
    assert_eq!(s.fund.holdings().get_unchecked(0), 149_750_000);
    assert_eq!(s.fund.holdings().get_unchecked(1), 150_000_000);
    assert_eq!(s.assets[0].token.balance(&s.manager), 0);
    assert_eq!(s.assets[1].token.balance(&s.manager), 0);
    assert!(s.fund.window_loss_ppb() > 0);
}

#[test]
fn trade_demands_the_larger_of_the_callers_minimum_and_the_oracle_floor() {
    let s = trading_fund();
    let router = with_router(&s, 9_850);
    let (sell, buy) = (&s.assets[1].token.address, &s.assets[0].token.address);
    let path = route(&s, 1, 0);

    // 1.5% worse than the oracle: the router is asked for at least 99%.
    assert!(s
        .fund
        .try_trade(sell, &(5 * SHARE_SCALE), buy, &0, &path)
        .is_err());

    router.configure(&9_950, &false, &false);
    assert!(s
        .fund
        .try_trade(sell, &(5 * SHARE_SCALE), buy, &49_800_000, &path)
        .is_err());
    assert_eq!(
        s.fund
            .trade(sell, &(5 * SHARE_SCALE), buy, &49_700_000, &path),
        49_750_000
    );
}

#[test]
fn trade_trusts_balances_not_the_router() {
    let s = trading_fund();
    let router = with_router(&s, 10_000);
    let (sell, buy) = (&s.assets[1].token.address, &s.assets[0].token.address);
    let path = route(&s, 1, 0);

    router.configure(&10_000, &true, &false);
    assert_eq!(
        s.fund.try_trade(sell, &(5 * SHARE_SCALE), buy, &0, &path),
        Err(Ok(FundError::SwapShortfall.into()))
    );
}

#[test]
fn the_fund_authorizes_exactly_its_input_and_nothing_more() {
    let s = trading_fund();
    let router = with_router(&s, 10_000);
    router.configure(&10_000, &false, &true);
    let (sell, buy) = (&s.assets[1].token.address, &s.assets[0].token.address);
    let path = route(&s, 1, 0);
    s.env.mock_auths(&[MockAuth {
        address: &s.manager,
        invoke: &MockAuthInvoke {
            contract: &s.fund.address,
            fn_name: "trade",
            args: (sell, 5 * SHARE_SCALE, buy, 0i128, path.clone()).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    let result = s.fund.try_trade(sell, &(5 * SHARE_SCALE), buy, &0, &path);
    assert!(result.is_err());
    assert_ne!(result, Err(Ok(FundError::SwapShortfall.into())));
    assert_eq!(s.fund.holdings().get_unchecked(1), 200_000_000);
}

#[test]
fn trade_checks_route_and_router() {
    let s = trading_fund();
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    #[cfg(not(any(feature = "mainnet", feature = "testnet")))]
    assert_eq!(
        s.fund.try_trade(b, &SHARE_SCALE, a, &0, &route(&s, 1, 0)),
        Err(Ok(FundError::NoRouter.into()))
    );
    with_router(&s, 10_000);
    for path in [
        route(&s, 0, 1),
        vec![&s.env, b.clone()],
        vec![
            &s.env,
            b.clone(),
            b.clone(),
            a.clone(),
            b.clone(),
            a.clone(),
        ],
    ] {
        assert_eq!(
            s.fund.try_trade(b, &SHARE_SCALE, a, &0, &path),
            Err(Ok(FundError::InvalidPath.into()))
        );
    }
    let hop = vec![
        &s.env,
        b.clone(),
        s.assets[2].token.address.clone(),
        a.clone(),
    ];
    assert_eq!(s.fund.trade(b, &SHARE_SCALE, a, &0, &hop), SHARE_SCALE);
}

#[test]
fn a_locked_fund_trades_among_its_components() {
    let s = setup(Compliance::Open, [false; 3]);
    assert_eq!(s.fund.mandate(), Mandate::Locked);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    with_router(&s, 10_000);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    assert_eq!(
        s.fund.trade(b, &SHARE_SCALE, a, &0, &route(&s, 1, 0)),
        SHARE_SCALE
    );
    assert_eq!(s.fund.holdings().get_unchecked(0), 110_000_000);
}

#[test]
fn trades_share_the_rebalance_cooldown_and_loss_budget() {
    let s = trading_fund();
    with_router(&s, 9_920);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    s.assets[0].admin.mint(&s.manager, &(10 * SHARE_SCALE));

    at(&s, 1_000);
    s.fund.trade(b, &(5 * SHARE_SCALE), a, &0, &route(&s, 1, 0));
    assert_eq!(
        s.fund.try_rebalance(b, &SHARE_SCALE, a, &SHARE_SCALE),
        Err(Ok(FundError::RebalanceCooldown.into()))
    );

    // Each trade gives up 0.8% of $5 out of a ~$35 fund, about 11.4 bps.
    let mut now = 1_000;
    let mut accepted = 1;
    let refused = loop {
        now += 60;
        at(&s, now);
        let (sell, path) = if accepted % 2 == 0 {
            (b, route(&s, 1, 0))
        } else {
            (a, route(&s, 0, 1))
        };
        let buy = &path.last_unchecked();
        match s.fund.try_trade(sell, &(5 * SHARE_SCALE), buy, &0, &path) {
            Ok(_) => accepted += 1,
            Err(error) => break error,
        }
        assert!(accepted < 32);
    };
    assert_eq!(refused, Ok(FundError::LossBudgetExceeded.into()));
    assert!(s.fund.window_loss_ppb() <= crate::MAX_WINDOW_LOSS_BPS * 100_000);
}

#[test]
fn router_is_set_by_the_platform_admin() {
    let s = setup(Compliance::Open, [false; 3]);
    #[cfg(not(any(feature = "mainnet", feature = "testnet")))]
    assert_eq!(s.fund.router(), None);
    #[cfg(feature = "mainnet")]
    assert_eq!(
        s.fund.router(),
        Some(Address::from_str(
            &s.env,
            "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH"
        ))
    );
    let router = Address::generate(&s.env);
    s.fund.set_router(&router);
    assert_eq!(s.env.auths()[0].0, s.fund.platform());
    assert_eq!(s.fund.router(), Some(router));
}

/// An open fund holding 10 shares under `mandate`, with an oracle, a
/// one-to-one router and a manager able to fund a rebalance.
fn fund_with_mandate<'a>(mandate: Mandate) -> Setup<'a> {
    let s = setup_closed(Compliance::Open, [false; 3]);
    if mandate != Mandate::Locked {
        s.fund.set_mandate(&mandate);
    }
    s.fund.open_for_issue();
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    s.assets[1].admin.mint(&s.manager, &(10 * SHARE_SCALE));
    s
}

/// The contract error a call failed with, or `None` if it succeeded.
fn refusal<T, C, E>(
    result: Result<Result<T, C>, Result<soroban_sdk::Error, E>>,
) -> Option<FundError> {
    match result {
        Ok(_) => None,
        Err(Ok(error)) => Some(FundError::try_from(error).unwrap()),
        Err(Err(_)) => panic!("call failed outside the contract"),
    }
}

#[test]
fn each_mandate_allows_exactly_its_actions() {
    use FundError::{MandateLocked, MandateStatic};
    for (mandate, trading, adding) in [
        (Mandate::Locked, None, Some(MandateLocked)),
        (Mandate::Managed, None, None),
        (Mandate::Static, Some(MandateStatic), Some(MandateStatic)),
    ] {
        let s = fund_with_mandate(mandate);
        assert_eq!(s.fund.mandate(), mandate);
        with_router(&s, 10_000);
        let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);

        let rebalanced = refusal(s.fund.try_rebalance(a, &SHARE_SCALE, b, &SHARE_SCALE));
        assert_eq!(rebalanced, trading, "rebalance under {mandate:?}");
        at(&s, 60);
        let traded = refusal(s.fund.try_trade(b, &SHARE_SCALE, a, &0, &route(&s, 1, 0)));
        assert_eq!(traded, trading, "trade under {mandate:?}");

        let extra = create_asset(&s.env, false);
        let added = refusal(s.fund.try_add_component(&extra.token.address));
        assert_eq!(added, adding, "add_component under {mandate:?}");
    }
}

#[test]
fn static_is_chosen_once_before_opening() {
    let s = setup_closed(Compliance::Open, [false; 3]);
    s.fund.set_mandate(&Mandate::Static);
    assert_eq!(
        s.fund.try_set_mandate(&Mandate::Managed),
        Err(Ok(FundError::MandateFixed.into()))
    );
    s.fund.open_for_issue();
    assert_eq!(s.fund.mandate(), Mandate::Static);
}

// Regressions for the v0.5 contract audit. Each test is the audit's proof,
// turned around to assert the fix (or, where a finding is accepted, to pin
// the documented behavior).

fn nav_of<'a>(s: &Setup<'a>) -> MockNavClient<'a> {
    MockNavClient::new(&s.env, &s.fund.nav().unwrap())
}

/// AUD-04: the audit's stale-oracle rebalance (oracle at $0.40, market at
/// $0.30, a day-old fallback print) is refused, as is a stale primary or a
/// primary more than 2% from a fresh second source, on both trade paths.
#[test]
fn trades_refuse_fallback_stale_or_divergent_prices() {
    let s = trading_fund();
    let router = with_router(&s, 10_000);
    let nav = nav_of(&s);
    at(&s, 2 * 24 * 60 * 60);
    let (usdc, xlm) = (&s.assets[0].token.address, &s.assets[1].token.address);
    s.assets[1].admin.mint(&s.manager, &(1_000 * SHARE_SCALE));
    let sold = 5 * SHARE_SCALE;
    let path = route(&s, 0, 1);
    let refusals = |error: FundError| {
        assert_eq!(
            s.fund.try_rebalance(usdc, &sold, xlm, &(sold * 5 / 2)),
            Err(Ok(error.into()))
        );
        assert_eq!(
            s.fund.try_trade(usdc, &sold, xlm, &0, &path),
            Err(Ok(error.into()))
        );
    };

    // The audit's case: the primary went quiet and NAV fell back to a
    // RedStone print from yesterday.
    nav.set(xlm, &40_000_000);
    nav.set_quality(xlm, &(25 * 60 * 60), &None);
    nav.set_fallback(xlm, &true);
    refusals(FundError::UnconfirmedPrice);
    nav.set_quality(xlm, &60, &None);
    refusals(FundError::UnconfirmedPrice);
    nav.set_fallback(xlm, &false);
    nav.set_quality(xlm, &(crate::MAX_TRADE_PRICE_AGE_SECONDS + 1), &Some(0));
    refusals(FundError::StalePrice);
    nav.set_quality(xlm, &(crate::MAX_TRADE_PRICE_AGE_SECONDS + 1), &None);
    refusals(FundError::StalePrice);
    nav.set_quality(xlm, &60, &Some(crate::MAX_TRADE_DIVERGENCE_BPS + 1));
    refusals(FundError::PriceDivergence);
    assert_eq!(s.fund.window_loss_ppb(), 0);
    assert_eq!(s.assets[0].token.balance(&s.manager), 0);

    // The sold leg is checked as strictly as the bought one.
    nav.set(xlm, &100_000_000);
    nav.set_quality(xlm, &0, &Some(0));
    nav.set_fallback(usdc, &true);
    refusals(FundError::UnconfirmedPrice);

    nav.set_fallback(usdc, &false);
    nav.set_quality(usdc, &crate::MAX_TRADE_PRICE_AGE_SECONDS, &Some(0));
    nav.set_quality(xlm, &0, &Some(crate::MAX_TRADE_DIVERGENCE_BPS));
    router.configure(&10_000, &false, &false);
    s.fund.trade(usdc, &sold, xlm, &0, &path);
}

/// A fresh primary with no fresh second reading (a single route, or a
/// RedStone secondary hours old, which NAV still calls fresh) may trade,
/// but each such leg costs at least `UNCONFIRMED_PRICE_CHARGE_BPS` of its
/// value in both loss budgets. An old secondary is still heard: past the
/// 2% cap it refuses the trade, and under it the charge is the larger of
/// its divergence and the flat charge.
#[test]
fn an_unconfirmed_primary_trades_and_is_charged() {
    let s = trading_fund();
    let nav = nav_of(&s);
    at(&s, 2 * 24 * 60 * 60);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    s.assets[0].admin.mint(&s.manager, &(20 * SHARE_SCALE));
    let five = 5 * SHARE_SCALE;

    // Single source on the bought leg: 50 bps of $5 against a $35 fund.
    nav.set_quality(a, &0, &None);
    s.fund.rebalance(b, &five, a, &five);
    assert_eq!(s.fund.window_loss_ppb(), 714_286);

    // A day-old secondary 9% away refuses the trade.
    at(&s, 2 * 24 * 60 * 60 + 60);
    nav.set_readings(b, &0, &Some(900), &(25 * 60 * 60));
    assert_eq!(
        s.fund.try_rebalance(b, &five, a, &five),
        Err(Ok(FundError::PriceDivergence.into()))
    );

    // 30 bps from a day-old secondary is charged as unconfirmed, 50 bps.
    nav.set_readings(b, &0, &Some(30), &(25 * 60 * 60));
    s.fund.rebalance(b, &five, a, &five);
    assert_eq!(s.fund.window_loss_ppb(), 714_286 + 1_428_572);

    // 120 bps from a day-old secondary is charged as measured.
    at(&s, 2 * 24 * 60 * 60 + 120);
    nav.set_readings(b, &0, &Some(120), &(25 * 60 * 60));
    s.fund.rebalance(b, &five, a, &five);
    let used = 714_286 + 1_428_572 + 2_428_572;
    assert_eq!(s.fund.window_loss_ppb(), used);
    assert_eq!(s.fund.month_loss_ppb(), used);
}

/// The fee used to be computed as `supply * accrued * 1e9` in one product,
/// and an overflow minted nothing while the clock still moved on, so a
/// large enough fund paid no fee at all. The split never forms that
/// product: at 5% for a year the fee is exactly `supply / 19`.
#[test]
fn the_fee_is_exact_at_any_supply() {
    for supply in [1, 10 * SHARE_SCALE, i128::MAX / 1_000_000, i128::MAX / 20] {
        let (shares, fraction) = crate::fee_split(supply, 500, YEAR_SECONDS).unwrap();
        assert_eq!(shares, supply / 19);
        assert_eq!(fraction, supply % 19 * 1_000_000_000 / 19);
    }
    let (shares, _) = crate::fee_split(10 * SHARE_SCALE, 50, 86_400).unwrap();
    assert_eq!(shares, 1_369);
}

/// When the fee cannot be minted because the supply would overflow,
/// accrual mints nothing and leaves the clock alone, so the fee waits
/// instead of being written off; it still never fails.
#[test]
fn an_unmintable_fee_waits_and_never_blocks() {
    let s = with_fee(Compliance::Open, 500);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &SHARE_SCALE);
    let set_supply = |supply: i128| {
        s.env.as_contract(&s.fund.address, || {
            crate::storage::set_supply(&s.env, supply)
        })
    };

    set_supply(i128::MAX - 1);
    at(&s, YEAR_SECONDS);
    assert_eq!(s.fund.pending_fee(), 0);
    assert_eq!(s.fund.accrue_fee(), 0);
    assert_eq!(s.fund.fee().unwrap().last_accrual, 0);

    let huge = 1_000_000_000_000_000_000_000_000_000_000i128;
    set_supply(huge);
    assert_eq!(s.fund.accrue_fee(), huge / 19);
    assert_eq!(s.fund.fee().unwrap().last_accrual, YEAR_SECONDS);
}

/// AUD-04: a value-neutral rebalance used to log zero loss whatever the
/// oracle's uncertainty. Each leg's divergence is now charged to both loss
/// budgets: 50 bps on $5 out and $5 in is $0.05 of a $35 fund.
#[test]
fn oracle_divergence_is_charged_to_the_loss_budget() {
    let s = trading_fund();
    let nav = nav_of(&s);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    nav.set_quality(a, &0, &Some(50));
    nav.set_quality(b, &0, &Some(50));
    s.assets[0].admin.mint(&s.manager, &(5 * SHARE_SCALE));
    s.fund
        .rebalance(b, &(5 * SHARE_SCALE), a, &(5 * SHARE_SCALE));
    assert_eq!(s.fund.window_loss_ppb(), 1_428_572);
    assert_eq!(s.fund.month_loss_ppb(), 1_428_572);
}

/// AUD-03: the audit's manager took 38% of the fund in 30 days by using
/// the 2% daily budget every day. Losses over any 30 days now stop at 5%,
/// and the budget comes back only once they age out.
#[test]
fn losses_over_thirty_days_are_capped_at_five_percent() {
    let s = managed(Compliance::Open);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(100 * SHARE_SCALE));
    with_oracle(&s);
    for asset in &s.assets {
        asset.admin.mint(&s.manager, &(100_000 * SHARE_SCALE));
    }
    let value = |s: &Setup| -> i128 { s.fund.holdings().iter().sum() };
    let start = value(&s);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    let bleed = |s: &Setup, now: u64| {
        at(s, now);
        let holdings = s.fund.holdings();
        let (sell, buy, sold) = if holdings.get_unchecked(0) > holdings.get_unchecked(1) {
            (a, b, holdings.get_unchecked(0))
        } else {
            (b, a, holdings.get_unchecked(1))
        };
        // The largest fill the per-trade floor and the daily window accept.
        let budget = (200 * 100_000 - s.fund.window_loss_ppb()) * value(s) / 1_000_000_000;
        let loss = (sold / 100).min(budget - 1).max(1);
        s.fund.try_rebalance(sell, &sold, buy, &(sold - loss))
    };
    let (mut accepted, mut refused) = (0, 0);
    for day in 0..30u64 {
        for half in 0..2u64 {
            match bleed(&s, day * 86_400 + half * 43_200 + 60) {
                Ok(_) => accepted += 1,
                Err(error) => {
                    assert_eq!(error, Ok(FundError::LossBudgetExceeded.into()));
                    refused += 1;
                }
            }
        }
    }
    let end = value(&s);
    assert!(
        accepted > 0 && refused > 50,
        "{accepted} accepted, {refused} refused"
    );
    assert!(s.fund.month_loss_ppb() <= crate::MAX_LONG_WINDOW_LOSS_BPS * 100_000);
    assert!(end * 100 >= start * 95, "{start} -> {end}");

    // 31 days after the first losing day, its losses no longer count.
    assert!(bleed(&s, 31 * 86_400 + 60).is_ok());
}

/// AUD-05: 1,440 minutely `accrue_fee` calls used to mint nothing where one
/// daily call mints 1,369 shares. The unminted fraction now carries over,
/// so they mint the same within a share.
#[test]
fn frequent_accrual_mints_the_same_fee_as_one_accrual() {
    let daily = with_fee(Compliance::Open, 50);
    let minutely = with_fee(Compliance::Open, 50);
    for s in [&daily, &minutely] {
        let investor = funded_investor(s, 1_000 * SHARE_SCALE);
        s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    }
    for minute in 1..=1_440u64 {
        at(&minutely, minute * 60);
        minutely.fund.accrue_fee();
        assert_eq!(minutely.fund.pending_fee(), 0);
    }
    at(&daily, 86_400);
    assert_eq!(daily.fund.pending_fee(), 1_369);
    assert_eq!(daily.fund.accrue_fee(), 1_369);
    let paid = minutely.fund.balance(&minutely.manager);
    assert!((paid - 1_369).abs() <= 1, "minutely accrual paid {paid}");
}

/// AUD-11: `burn` used to change supply without accruing first, cutting the
/// year's fee from 28,862,589 to 5,263,157 shares. It now accrues first, so
/// burning gives the same fee whether or not someone accrued just before.
#[test]
fn burn_accrues_the_fee_first() {
    let accrued = with_fee(Compliance::Open, 500);
    let direct = with_fee(Compliance::Open, 500);
    for s in [&accrued, &direct] {
        let investor = funded_investor(s, 1_000 * SHARE_SCALE);
        s.fund.issue(&investor, &investor, &(100 * SHARE_SCALE));
        at(s, YEAR_SECONDS / 2);
        if core::ptr::eq(s, &accrued) {
            s.fund.accrue_fee();
        }
        s.fund.burn(&investor, &(90 * SHARE_SCALE));
        at(s, YEAR_SECONDS);
        s.fund.accrue_fee();
    }
    assert_eq!(
        direct.fund.balance(&direct.manager),
        accrued.fund.balance(&accrued.manager)
    );
    assert!(direct.fund.balance(&direct.manager) > 28_000_000);
}

/// AUD-14: shares held by the fund's own address could never move again.
/// Every path that names a holder now refuses the fund itself.
#[test]
fn the_fund_cannot_hold_its_own_shares() {
    let s = setup(Compliance::Open, [false; 3]);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    let fund = s.fund.address.clone();
    let refused = Some(Ok(FundError::FundAsHolder.into()));
    assert_eq!(
        s.fund.try_issue(&investor, &fund, &SHARE_SCALE).err(),
        refused
    );
    s.fund.issue(&investor, &investor, &SHARE_SCALE);
    assert_eq!(s.fund.try_transfer(&investor, &fund, &1).err(), refused);
    assert_eq!(s.fund.try_set_fee_recipient(&fund).err(), refused);
    assert_eq!(s.fund.try_set_platform_fee(&1_000, &fund).err(), refused);
}

/// A SEP-41 token whose `balance` can be made to trap, as an upgradeable or
/// pausable custom token could. Not a SAC.
#[contract]
struct TrapToken;

#[contractimpl]
impl TrapToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&to, &(balance + amount));
    }

    pub fn break_it(env: Env) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("broken"), &true);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        if env
            .storage()
            .instance()
            .has(&soroban_sdk::symbol_short!("broken"))
        {
            panic!("paused");
        }
        env.storage().persistent().get(&id).unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_balance = Self::balance(env.clone(), from.clone());
        assert!(from_balance >= amount);
        env.storage()
            .persistent()
            .set(&from, &(from_balance - amount));
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&to, &(to_balance + amount));
    }
}

/// AUD-07, accepted: a component whose `balance` traps blocks every
/// redemption, and `skip` cannot help. SAC `balance` never traps, which is
/// why the shelf admits SACs only.
#[test]
fn a_trapping_non_sac_component_blocks_redemption() {
    let env = Env::default();
    env.mock_all_auths();
    let good = create_asset(&env, false);
    let trap_id = env.register(TrapToken, ());
    let trap = TrapTokenClient::new(&env, &trap_id);
    let components = vec![
        &env,
        Component {
            token: good.token.address.clone(),
            initial_units: SHARE_SCALE,
        },
        Component {
            token: trap_id.clone(),
            initial_units: SHARE_SCALE,
        },
    ];
    let id = env.register(
        Fund,
        (
            env.register(MockPlatform, ()),
            Address::generate(&env),
            String::from_str(&env, "T"),
            String::from_str(&env, "T"),
            components,
            Compliance::Open,
        ),
    );
    let fund = FundClient::new(&env, &id);
    fund.open_for_issue();
    let investor = Address::generate(&env);
    good.admin.mint(&investor, &(10 * SHARE_SCALE));
    trap.mint(&investor, &(10 * SHARE_SCALE));
    fund.issue(&investor, &investor, &SHARE_SCALE);

    trap.break_it();
    let skip = vec![&env, trap_id.clone()];
    assert!(fund
        .try_redeem(&investor, &investor, &SHARE_SCALE, &skip)
        .is_err());
    assert_eq!(good.token.balance(&id), SHARE_SCALE);
}

/// AUD-10, documented: after a clawback cuts below owed claims, settling
/// every claim still leaves `reserved > held`, and issuance stays shut
/// until someone (the manager) donates the gap back.
#[test]
fn issuance_reopens_once_a_clawback_gap_is_donated_back() {
    let s = setup(Compliance::Open, [false, false, true]);
    let a = funded_investor(&s, 1_000 * SHARE_SCALE);
    let b = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&a, &a, &SHARE_SCALE);
    s.fund.issue(&b, &b, &SHARE_SCALE);
    let leg = s.assets[2].token.address.clone();
    s.fund
        .redeem(&a, &a, &SHARE_SCALE, &vec![&s.env, leg.clone()]);
    let held = s.assets[2].token.balance(&s.fund.address);
    s.assets[2]
        .admin
        .clawback(&s.fund.address, &(held - 1_000_000));
    s.fund.withdraw_owed(&a, &a, &leg);
    let gap = s.fund.owed(&a, &leg);
    assert!(gap > 0);
    assert_eq!(
        s.fund.try_issue(&b, &b, &SHARE_SCALE),
        Err(Ok(FundError::ReserveShortfall.into()))
    );

    s.assets[2].admin.mint(&s.fund.address, &gap);
    s.fund.issue(&b, &b, &SHARE_SCALE);
}

/// The vault inflation attack does not apply to in-kind pro-rata issue: a
/// 1-stroop first holder who donates a large balance makes shares dearer,
/// but the next investor pays pro-rata and redeems what they paid, less at
/// most a stroop per leg.
#[test]
fn a_donation_inflation_attack_transfers_no_value() {
    let s = setup(Compliance::Open, [false; 3]);
    let attacker = funded_investor(&s, 1_000_000 * SHARE_SCALE);
    let victim = funded_investor(&s, 1_000_000 * SHARE_SCALE);
    s.fund.issue(&attacker, &attacker, &1);
    for asset in &s.assets {
        asset
            .token
            .transfer(&attacker, &s.fund.address, &(10_000 * SHARE_SCALE));
    }
    let before = balances(&s, &victim);
    s.fund.issue(&victim, &victim, &1);
    s.fund.redeem(&victim, &victim, &1, &Vec::new(&s.env));
    let after = balances(&s, &victim);
    for (paid, got) in before.iter().zip(after.iter()) {
        assert!(paid - got <= 1);
    }
}

// Wind-down and manager replacement by the platform admin.

#[test]
fn only_the_platform_admin_winds_down_or_replaces_the_manager() {
    let s = setup(Compliance::Open, [false; 3]);
    let usdc = s.assets[0].token.address.clone();
    let new_manager = Address::generate(&s.env);

    s.env.mock_auths(&[]);
    assert!(s.fund.try_wind_down(&None, &usdc).is_err());
    assert!(s.fund.try_replace_manager(&new_manager).is_err());
    s.env.mock_all_auths();

    s.fund.replace_manager(&new_manager);
    assert_eq!(s.env.auths()[0].0, s.fund.platform());
    assert_eq!(s.fund.manager(), new_manager);

    s.fund.wind_down(&None, &usdc);
    assert_eq!(s.env.auths()[0].0, s.fund.platform());
    assert_eq!(
        s.fund.wind_down_state(),
        Some(crate::WindDown {
            operator: None,
            usdc
        })
    );
}

#[test]
fn a_wound_down_fund_closes_issuance_and_revokes_the_manager() {
    let s = trading_fund();
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.wind_down(&None, a);

    assert!(!s.fund.is_open());
    assert_eq!(
        s.fund.try_issue(&investor, &investor, &SHARE_SCALE).err(),
        Some(Ok(FundError::IssuanceClosed.into()))
    );
    let revoked = Some(Ok(FundError::WoundDown.into()));
    let someone = Address::generate(&s.env);
    assert_eq!(s.fund.try_set_investor(&someone, &true).err(), revoked);
    assert_eq!(s.fund.try_set_fee_recipient(&someone).err(), revoked);
    assert_eq!(s.fund.try_set_manager(&someone).err(), revoked);
    assert_eq!(s.fund.try_replace_manager(&someone).err(), revoked);
    assert_eq!(
        s.fund
            .try_set_metadata(
                &Symbol::new(&s.env, "status"),
                &String::from_str(&s.env, "x")
            )
            .err(),
        revoked
    );
    assert_eq!(
        s.fund
            .try_add_component(&create_asset(&s.env, false).token.address)
            .err(),
        revoked
    );
    assert_eq!(
        s.fund.try_rebalance(b, &SHARE_SCALE, a, &SHARE_SCALE).err(),
        revoked
    );
    // With no operator, nobody trades at all.
    with_router(&s, 10_000);
    assert_eq!(
        s.fund
            .try_trade(b, &SHARE_SCALE, a, &0, &route(&s, 1, 0))
            .err(),
        revoked
    );
}

/// Winding down changes nothing a holder redeems: the quote at wind-down
/// is what they get, however long after, because the fee stops too.
#[test]
fn wind_down_never_blocks_or_reduces_a_redemption() {
    let s = with_fee(Compliance::Open, crate::MAX_FEE_BPS);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    at(&s, YEAR_SECONDS / 2);
    let quoted = s.fund.quote_redeem(&(10 * SHARE_SCALE));
    s.fund.wind_down(&None, &s.assets[0].token.address);
    assert_eq!(s.fund.quote_redeem(&(10 * SHARE_SCALE)), quoted);

    at(&s, 3 * YEAR_SECONDS);
    assert_eq!(s.fund.pending_fee(), 0);
    assert_eq!(s.fund.accrue_fee(), 0);
    let skip = vec![&s.env, s.assets[2].token.address.clone()];
    let got = s
        .fund
        .redeem(&investor, &investor, &(10 * SHARE_SCALE), &skip);
    assert_eq!(got, quoted);
    s.fund
        .withdraw_owed(&investor, &investor, &s.assets[2].token.address);
    assert_eq!(s.fund.balance(&investor), 0);
}

/// The operator can only swap a component into USDC inside the fund, under
/// the oracle floor and loss budgets; nothing reaches the operator.
#[test]
fn the_operator_only_trades_into_usdc_and_assets_stay_in_the_fund() {
    let s = trading_fund();
    with_router(&s, 9_950);
    let (usdc, b, c) = (
        &s.assets[0].token.address,
        &s.assets[1].token.address,
        &s.assets[2].token.address,
    );
    let operator = Address::generate(&s.env);
    s.fund.wind_down(&Some(operator.clone()), usdc);

    assert_eq!(
        s.fund
            .try_trade(b, &SHARE_SCALE, c, &0, &route(&s, 1, 2))
            .err(),
        Some(Ok(FundError::OnlyIntoUsdc.into()))
    );
    assert_eq!(
        s.fund
            .try_rebalance(b, &SHARE_SCALE, usdc, &SHARE_SCALE)
            .err(),
        Some(Ok(FundError::WoundDown.into()))
    );
    // Worse than the 1% floor is still refused.
    let router = MockRouterClient::new(&s.env, &s.fund.router().unwrap());
    router.configure(&9_850, &false, &false);
    assert!(s
        .fund
        .try_trade(b, &(5 * SHARE_SCALE), usdc, &0, &route(&s, 1, 0))
        .is_err());
    router.configure(&9_950, &false, &false);

    let before = s.fund.holdings();
    let bought = s
        .fund
        .trade(b, &(5 * SHARE_SCALE), usdc, &0, &route(&s, 1, 0));
    assert_eq!(s.env.auths()[0].0, operator);
    let after = s.fund.holdings();
    assert_eq!(after.get_unchecked(0), before.get_unchecked(0) + bought);
    assert_eq!(
        after.get_unchecked(1),
        before.get_unchecked(1) - 5 * SHARE_SCALE
    );
    assert_eq!(after.get_unchecked(2), before.get_unchecked(2));
    assert!(bought >= 5 * SHARE_SCALE * 99 / 100);
    assert!(s.fund.window_loss_ppb() > 0);
    for asset in &s.assets {
        assert_eq!(asset.token.balance(&operator), 0);
    }
}

#[test]
fn a_replaced_manager_loses_its_powers_and_its_fee() {
    let s = with_fee(Compliance::Open, 100);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    let treasury = Address::generate(&s.env);
    s.fund.set_fee_recipient(&treasury);

    at(&s, YEAR_SECONDS);
    let new_manager = Address::generate(&s.env);
    s.fund.replace_manager(&new_manager);
    let treasury_fee = s.fund.balance(&treasury);
    assert!(treasury_fee > 0);
    assert_eq!(s.fund.fee_recipient(), new_manager);

    let old = s.manager.clone();
    s.env.mock_auths(&[MockAuth {
        address: &old,
        invoke: &MockAuthInvoke {
            contract: &s.fund.address,
            fn_name: "set_investor",
            args: (&investor, false).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.fund.try_set_investor(&investor, &false).is_err());
    s.env.mock_all_auths();
    s.fund.set_investor(&investor, &false);
    assert_eq!(s.env.auths()[0].0, new_manager);

    at(&s, 2 * YEAR_SECONDS);
    s.fund.accrue_fee();
    assert_eq!(s.fund.balance(&treasury), treasury_fee);
    assert!(s.fund.balance(&new_manager) > 0);
}
