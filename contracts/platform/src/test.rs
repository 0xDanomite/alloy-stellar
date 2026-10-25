extern crate std;

use soroban_sdk::{
    testutils::{Address as _, IssuerFlags},
    token::StellarAssetClient,
    vec, Address, BytesN, Env, String, Vec,
};

use crate::{Compliance, Component, Platform, PlatformClient, PlatformError, ShelfStatus};

mod fund {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/alloy_fund.wasm");
}

const SCALE: i128 = 10_000_000;

struct Setup<'a> {
    env: Env,
    platform: PlatformClient<'a>,
    manager: Address,
    usdc: Address,
    benji_like: Address,
}

fn asset(env: &Env, permissioned: bool) -> Address {
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    if permissioned {
        sac.issuer().set_flag(IssuerFlags::RequiredFlag);
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    }
    sac.address()
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let wasm = env.deployer().upload_contract_wasm(fund::WASM);
    let admin = Address::generate(&env);
    let id = env.register(Platform, (admin, wasm));
    let platform = PlatformClient::new(&env, &id);
    let manager = Address::generate(&env);
    platform.set_manager(&manager, &true);
    let usdc = asset(&env, false);
    let benji_like = asset(&env, true);
    platform.set_shelf_asset(&usdc, &ShelfStatus::Open);
    platform.set_shelf_asset(&benji_like, &ShelfStatus::Permissioned);
    Setup {
        env,
        platform,
        manager,
        usdc,
        benji_like,
    }
}

fn components(env: &Env, tokens: &[&Address]) -> Vec<Component> {
    let mut list = Vec::new(env);
    for token in tokens {
        list.push_back(Component {
            token: (*token).clone(),
            initial_units: SCALE,
        });
    }
    list
}

fn salt(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

#[test]
fn creates_a_working_fund() {
    let s = setup();
    let name = String::from_str(&s.env, "Alloy Stellar Treasury");
    let symbol = String::from_str(&s.env, "aTRSY");
    let id = s.platform.create_fund(
        &s.manager,
        &name,
        &symbol,
        &components(&s.env, &[&s.usdc]),
        &Compliance::Open,
        &salt(&s.env, 1),
    );
    assert_eq!(s.platform.funds(&0, &50), vec![&s.env, id.clone()]);

    let fund = fund::Client::new(&s.env, &id);
    assert_eq!(fund.name(), name);
    assert_eq!(fund.manager(), s.manager);
    assert_eq!(fund.platform(), s.platform.address);

    let investor = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.usdc).mint(&investor, &(5 * SCALE));
    fund.issue(&investor, &investor, &(2 * SCALE));
    assert_eq!(fund.balance(&investor), 2 * SCALE);
}

#[test]
fn rejects_unlisted_managers_and_assets() {
    let s = setup();
    let x = String::from_str(&s.env, "x");
    let stranger = Address::generate(&s.env);
    assert_eq!(
        s.platform.try_create_fund(
            &stranger,
            &x,
            &x,
            &components(&s.env, &[&s.usdc]),
            &Compliance::Open,
            &salt(&s.env, 2),
        ),
        Err(Ok(PlatformError::NotManager.into()))
    );
    let off_shelf = asset(&s.env, false);
    assert_eq!(
        s.platform.try_create_fund(
            &s.manager,
            &x,
            &x,
            &components(&s.env, &[&off_shelf]),
            &Compliance::Open,
            &salt(&s.env, 3),
        ),
        Err(Ok(PlatformError::NotOnShelf.into()))
    );
}

#[test]
fn permissioned_assets_force_an_allowlist() {
    let s = setup();
    let x = String::from_str(&s.env, "x");
    let basket = components(&s.env, &[&s.usdc, &s.benji_like]);
    assert_eq!(
        s.platform.try_create_fund(
            &s.manager,
            &x,
            &x,
            &basket,
            &Compliance::Open,
            &salt(&s.env, 4)
        ),
        Err(Ok(PlatformError::PermissionedNeedsAllowlist.into()))
    );
    let id = s.platform.create_fund(
        &s.manager,
        &x,
        &x,
        &basket,
        &Compliance::Allowlist,
        &salt(&s.env, 5),
    );

    // Until the issuer authorizes the fund contract, nobody can buy in.
    let fund = fund::Client::new(&s.env, &id);
    let investor = Address::generate(&s.env);
    let benji = StellarAssetClient::new(&s.env, &s.benji_like);
    StellarAssetClient::new(&s.env, &s.usdc).mint(&investor, &(5 * SCALE));
    benji.set_authorized(&investor, &true);
    benji.mint(&investor, &(5 * SCALE));
    fund.set_investor(&investor, &true);
    assert!(fund.try_issue(&investor, &investor, &SCALE).is_err());

    benji.set_authorized(&id, &true);
    fund.issue(&investor, &investor, &SCALE);
    assert_eq!(fund.balance(&investor), SCALE);
}

#[test]
fn shelf_listing_round_trips() {
    let s = setup();
    assert_eq!(
        s.platform.shelf(),
        vec![&s.env, s.usdc.clone(), s.benji_like.clone()]
    );
    s.platform
        .set_shelf_asset(&s.usdc, &ShelfStatus::Permissioned);
    assert_eq!(s.platform.shelf().len(), 2);
    s.platform.set_shelf_asset(&s.usdc, &ShelfStatus::Unlisted);
    assert_eq!(s.platform.shelf(), vec![&s.env, s.benji_like.clone()]);
    assert_eq!(s.platform.shelf_status(&s.usdc), ShelfStatus::Unlisted);
}

#[test]
fn admin_actions_require_admin_auth() {
    let s = setup();
    let m = Address::generate(&s.env);
    s.platform.set_manager(&m, &true);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.platform.admin());
}

#[test]
fn only_platform_created_funds_are_genuine() {
    let s = setup();
    let x = String::from_str(&s.env, "x");
    let real = s.platform.create_fund(
        &s.manager,
        &x,
        &x,
        &components(&s.env, &[&s.usdc]),
        &Compliance::Open,
        &salt(&s.env, 9),
    );
    let spoof = s.env.register(
        fund::WASM,
        (
            s.platform.address.clone(),
            s.manager.clone(),
            x.clone(),
            x,
            components(&s.env, &[&s.usdc]),
            Compliance::Open,
        ),
    );
    assert_eq!(
        fund::Client::new(&s.env, &spoof).platform(),
        s.platform.address
    );
    assert!(s.platform.is_fund(&real));
    assert!(!s.platform.is_fund(&spoof));
}

#[test]
fn funds_page_through_indexed_entries() {
    let s = setup();
    let x = String::from_str(&s.env, "x");
    let mut created = std::vec::Vec::new();
    for n in 0..5u8 {
        created.push(s.platform.create_fund(
            &s.manager,
            &x,
            &x,
            &components(&s.env, &[&s.usdc]),
            &Compliance::Open,
            &salt(&s.env, 20 + n),
        ));
    }
    assert_eq!(s.platform.fund_count(), 5);
    let page = s.platform.funds(&1, &2);
    assert_eq!(page, vec![&s.env, created[1].clone(), created[2].clone()]);
    assert_eq!(s.platform.funds(&4, &10).len(), 1);
    assert_eq!(s.platform.funds(&9, &10).len(), 0);
}

#[test]
fn same_salt_from_two_managers_yields_two_funds() {
    let s = setup();
    let other = Address::generate(&s.env);
    s.platform.set_manager(&other, &true);
    let x = String::from_str(&s.env, "x");
    let basket = components(&s.env, &[&s.usdc]);
    let a = s.platform.create_fund(
        &s.manager,
        &x,
        &x,
        &basket,
        &Compliance::Open,
        &salt(&s.env, 30),
    );
    let b = s.platform.create_fund(
        &other,
        &x,
        &x,
        &basket,
        &Compliance::Open,
        &salt(&s.env, 30),
    );
    assert_ne!(a, b);
}

#[test]
fn real_platform_keeps_a_permissioned_fund_on_its_allowlist() {
    let s = setup();
    let x = String::from_str(&s.env, "x");
    let id = s.platform.create_fund(
        &s.manager,
        &x,
        &x,
        &components(&s.env, &[&s.usdc, &s.benji_like]),
        &Compliance::Allowlist,
        &salt(&s.env, 40),
    );
    let fund = fund::Client::new(&s.env, &id);
    assert!(fund.try_set_compliance(&fund::Compliance::Open).is_err());

    let open_only = s.platform.create_fund(
        &s.manager,
        &x,
        &x,
        &components(&s.env, &[&s.usdc]),
        &Compliance::Allowlist,
        &salt(&s.env, 41),
    );
    let fund = fund::Client::new(&s.env, &open_only);
    fund.set_compliance(&fund::Compliance::Open);
    assert_eq!(fund.compliance(), fund::Compliance::Open);
}
