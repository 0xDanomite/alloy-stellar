extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, IssuerFlags, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, String, Symbol, Vec,
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

/// Every token is worth $1 except the one stored under "px", at its stored price.
#[contract]
struct MockNav;

#[contractimpl]
impl MockNav {
    pub fn set(env: Env, token: Address, price: i128) {
        env.storage().instance().set(&token, &price);
    }

    pub fn price(env: Env, token: Address) -> PriceQuote {
        PriceQuote {
            price: env.storage().instance().get(&token).unwrap_or(100_000_000),
            timestamp: env.ledger().timestamp(),
            source: soroban_sdk::symbol_short!("mock"),
            divergence_bps: None,
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
    let s = managed(Compliance::Open);
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
    let s = managed(Compliance::Open);
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
    let s = managed(Compliance::Open);
    let investor = funded_investor(&s, 100 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
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
fn a_fund_is_locked_unless_its_manager_chose_managed_before_opening() {
    let s = setup(Compliance::Open, [false; 3]);
    assert_eq!(s.fund.mandate(), Mandate::Locked);
    let investor = funded_investor(&s, 1_000 * SHARE_SCALE);
    s.fund.issue(&investor, &investor, &(10 * SHARE_SCALE));
    with_oracle(&s);
    let (a, b) = (&s.assets[0].token.address, &s.assets[1].token.address);
    assert_eq!(
        s.fund.try_rebalance(a, &SHARE_SCALE, b, &SHARE_SCALE),
        Err(Ok(FundError::MandateLocked.into()))
    );
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
