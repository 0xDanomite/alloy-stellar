extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _, IssuerFlags, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Symbol, Vec,
};

use crate::{Zap, ZapClient, ZapError};

mod fund {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/alloy_fund.wasm");
}

const SCALE: i128 = 10_000_000;
const USDC_PER_TOKEN: i128 = SCALE;

/// A stand-in for the Soroswap router with the same call shape and the same
/// auth demands: it requires `to`'s auth and pulls `amounts[0]` of `path[0]`
/// from `to` into the pool, here the router itself. Each token has a fixed
/// price in USDC per whole token; only the path's ends set the rate.
/// `short` pays one unit less than an exact-out swap promised, `bonus` one
/// unit more.
#[contract]
struct MockRouter;

fn price(env: &Env, token: &Address) -> i128 {
    env.storage()
        .instance()
        .get(token)
        .unwrap_or(USDC_PER_TOKEN)
}

fn flag(env: &Env, name: &str) -> bool {
    env.storage()
        .instance()
        .get(&Symbol::new(env, name))
        .unwrap_or(false)
}

fn amounts(env: &Env, path: &Vec<Address>, first: i128, last: i128) -> Vec<i128> {
    let mut amounts = Vec::new(env);
    for i in 0..path.len() {
        amounts.push_back(if i + 1 == path.len() { last } else { first });
    }
    amounts
}

fn amount_in(env: &Env, amount_out: i128, path: &Vec<Address>) -> i128 {
    let numerator = amount_out * price(env, &path.last_unchecked());
    let denominator = price(env, &path.first_unchecked());
    (numerator + denominator - 1) / denominator
}

fn amount_out(env: &Env, amount_in: i128, path: &Vec<Address>) -> i128 {
    amount_in * price(env, &path.first_unchecked()) / price(env, &path.last_unchecked())
}

#[contractimpl]
impl MockRouter {
    pub fn set_price(env: Env, token: Address, usdc_per_token: i128) {
        env.storage().instance().set(&token, &usdc_per_token);
    }

    pub fn set_flag(env: Env, name: Symbol, on: bool) {
        env.storage().instance().set(&name, &on);
    }

    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn router_get_amounts_in(env: Env, amount_out: i128, path: Vec<Address>) -> Vec<i128> {
        amounts(&env, &path, amount_in(&env, amount_out, &path), amount_out)
    }

    pub fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128> {
        amounts(&env, &path, amount_in, amount_out(&env, amount_in, &path))
    }

    pub fn swap_tokens_for_exact_tokens(
        env: Env,
        amount_out: i128,
        amount_in_max: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        assert!(env.ledger().timestamp() < deadline, "deadline expired");
        let pulled = amount_in(&env, amount_out, &path);
        assert!(pulled <= amount_in_max, "excessive input amount");
        let pool = env.current_contract_address();
        TokenClient::new(&env, &path.first_unchecked()).transfer(&to, &pool, &pulled);
        let paid = if flag(&env, "short") {
            amount_out - 1
        } else if flag(&env, "bonus") {
            amount_out + 1
        } else {
            amount_out
        };
        TokenClient::new(&env, &path.last_unchecked()).transfer(&pool, &to, &paid);
        amounts(&env, &path, pulled, paid)
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
        let out = amount_out(&env, amount_in, &path);
        assert!(
            out > 0 && out >= amount_out_min,
            "insufficient output amount"
        );
        let pool = env.current_contract_address();
        TokenClient::new(&env, &path.first_unchecked()).transfer(&to, &pool, &amount_in);
        TokenClient::new(&env, &path.last_unchecked()).transfer(&pool, &to, &out);
        amounts(&env, &path, amount_in, out)
    }
}

/// A fund of 5 USDC, 2 USTRY-like at $1.05 and 30 XLM-like at $0.10 per
/// share: 10.10 USDC a share at the router's prices.
struct Setup<'a> {
    env: Env,
    zap: ZapClient<'a>,
    router: MockRouterClient<'a>,
    fund: fund::Client<'a>,
    manager: Address,
    usdc: Address,
    ustry: Address,
    xlm: Address,
}

fn sac(env: &Env, permissioned: bool) -> Address {
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    if permissioned {
        sac.issuer().set_flag(IssuerFlags::RequiredFlag);
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    }
    sac.address()
}

fn setup<'a>(compliance: fund::Compliance, permissioned_ustry: bool) -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let usdc = sac(&env, false);
    let ustry = sac(&env, permissioned_ustry);
    let xlm = sac(&env, false);

    let router = MockRouterClient::new(&env, &env.register(MockRouter, ()));
    router.set_price(&ustry, &10_500_000);
    router.set_price(&xlm, &1_000_000);
    for token in [&usdc, &ustry, &xlm] {
        if permissioned_ustry && token == &ustry {
            StellarAssetClient::new(&env, token).set_authorized(&router.address, &true);
        }
        StellarAssetClient::new(&env, token).mint(&router.address, &(1_000_000 * SCALE));
    }

    let manager = Address::generate(&env);
    let components = vec![
        &env,
        fund::Component {
            token: usdc.clone(),
            initial_units: 5 * SCALE,
        },
        fund::Component {
            token: ustry.clone(),
            initial_units: 2 * SCALE,
        },
        fund::Component {
            token: xlm.clone(),
            initial_units: 30 * SCALE,
        },
    ];
    let fund_id = env.register(
        fund::WASM,
        (
            Address::generate(&env),
            manager.clone(),
            String::from_str(&env, "Alloy Liquid"),
            String::from_str(&env, "aLQD"),
            components,
            compliance,
        ),
    );
    let fund = fund::Client::new(&env, &fund_id);
    if permissioned_ustry {
        StellarAssetClient::new(&env, &ustry).set_authorized(&fund_id, &true);
    }
    fund.open_for_issue();

    let zap = ZapClient::new(
        &env,
        &env.register(Zap, (router.address.clone(), usdc.clone())),
    );
    Setup {
        env,
        zap,
        router,
        fund,
        manager,
        usdc,
        ustry,
        xlm,
    }
}

fn open<'a>() -> Setup<'a> {
    setup(fund::Compliance::Open, false)
}

impl Setup<'_> {
    fn investor(&self, usdc: i128) -> Address {
        let investor = Address::generate(&self.env);
        StellarAssetClient::new(&self.env, &self.usdc).mint(&investor, &usdc);
        investor
    }

    fn path(&self, tokens: &[&Address]) -> Vec<Address> {
        let mut path = Vec::new(&self.env);
        for token in tokens {
            path.push_back((*token).clone());
        }
        path
    }

    fn buy_paths(&self) -> Vec<Vec<Address>> {
        vec![
            &self.env,
            self.path(&[&self.usdc, &self.ustry]),
            self.path(&[&self.usdc, &self.xlm]),
        ]
    }

    fn sell_paths(&self) -> Vec<Vec<Address>> {
        vec![
            &self.env,
            self.path(&[&self.ustry, &self.usdc]),
            self.path(&[&self.xlm, &self.usdc]),
        ]
    }

    fn balance(&self, token: &Address, who: &Address) -> i128 {
        TokenClient::new(&self.env, token).balance(who)
    }

    fn assert_zap_holds_nothing(&self) {
        for token in [&self.usdc, &self.ustry, &self.xlm] {
            assert_eq!(self.balance(token, &self.zap.address), 0);
        }
        assert_eq!(self.fund.balance(&self.zap.address), 0);
    }

    /// Only `who` signs: one call to the zap, under it the one transfer or
    /// redeem the zap makes with `who`'s authority. The zap's own transfers
    /// must come from its own `authorize_as_current_contract`.
    fn sign_only(&self, who: &Address, fn_name: &'static str, args: Vec<soroban_sdk::Val>) {
        let (contract, sub_fn, sub_args) = if fn_name == "issue_with_usdc" {
            let max_usdc: i128 = args.get_unchecked(3).into_val(&self.env);
            (
                self.usdc.clone(),
                "transfer",
                (who.clone(), self.zap.address.clone(), max_usdc).into_val(&self.env),
            )
        } else {
            let shares: i128 = args.get_unchecked(2).into_val(&self.env);
            (
                self.fund.address.clone(),
                "redeem",
                (
                    who.clone(),
                    self.zap.address.clone(),
                    shares,
                    Vec::<Address>::new(&self.env),
                )
                    .into_val(&self.env),
            )
        };
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.zap.address,
                fn_name,
                args,
                sub_invokes: &[MockAuthInvoke {
                    contract: &contract,
                    fn_name: sub_fn,
                    args: sub_args,
                    sub_invokes: &[],
                }],
            },
        }]);
    }

    /// Mainnet's per-transaction limits: 100M instructions, 40 MiB.
    fn assert_within_limits(&self) {
        let budget = self.env.cost_estimate().budget();
        assert!(budget.cpu_instruction_cost() < 100_000_000);
        assert!(budget.memory_bytes_cost() < 40 * 1024 * 1024);
    }

    fn issue(&self, investor: &Address, shares: i128, max_usdc: i128) -> i128 {
        let paths = self.buy_paths();
        self.sign_only(
            investor,
            "issue_with_usdc",
            (
                investor.clone(),
                self.fund.address.clone(),
                shares,
                max_usdc,
                paths.clone(),
            )
                .into_val(&self.env),
        );
        self.env.cost_estimate().budget().reset_unlimited();
        let spent =
            self.zap
                .issue_with_usdc(investor, &self.fund.address, &shares, &max_usdc, &paths);
        self.assert_within_limits();
        self.env.mock_all_auths();
        spent
    }

    fn redeem(&self, owner: &Address, shares: i128, min_usdc: i128) -> i128 {
        let paths = self.sell_paths();
        self.sign_only(
            owner,
            "redeem_to_usdc",
            (
                owner.clone(),
                self.fund.address.clone(),
                shares,
                min_usdc,
                paths.clone(),
            )
                .into_val(&self.env),
        );
        self.env.cost_estimate().budget().reset_unlimited();
        let out = self
            .zap
            .redeem_to_usdc(owner, &self.fund.address, &shares, &min_usdc, &paths);
        self.assert_within_limits();
        self.env.mock_all_auths();
        out
    }
}

#[test]
fn issue_buys_the_exact_basket_and_refunds_the_rest() {
    let s = open();
    let investor = s.investor(50 * SCALE);

    let spent = s.issue(&investor, SCALE, 20 * SCALE);

    assert_eq!(spent, 101_000_000);
    assert_eq!(s.fund.balance(&investor), SCALE);
    assert_eq!(s.balance(&s.usdc, &investor), 50 * SCALE - 101_000_000);
    assert_eq!(
        s.fund.holdings(),
        vec![&s.env, 5 * SCALE, 2 * SCALE, 30 * SCALE]
    );
    s.assert_zap_holds_nothing();
}

#[test]
fn issue_rounds_up_like_the_fund_and_buys_what_the_quote_asks() {
    let s = open();
    let first = s.investor(50 * SCALE);
    s.issue(&first, SCALE, 20 * SCALE);

    // One donated stroop makes the USTRY leg round.
    StellarAssetClient::new(&s.env, &s.ustry).mint(&s.fund.address, &1);
    let second = s.investor(50 * SCALE);
    let shares = 3_333_333;
    let quote = s.fund.quote_issue(&shares);
    let spent = s.issue(&second, shares, 20 * SCALE);

    // 6_666_667 USTRY (rounded up) at 1.05 costs 7_000_001 USDC (rounded
    // up); 99_999_990 XLM at 0.10 costs 9_999_999.
    assert_eq!(quote, vec![&s.env, 16_666_665, 6_666_667, 99_999_990]);
    assert_eq!(spent, 16_666_665 + 7_000_001 + 9_999_999);
    assert_eq!(s.fund.balance(&second), shares);
    s.assert_zap_holds_nothing();
}

#[test]
fn issue_fails_when_the_basket_costs_more_than_max_usdc() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    let paths = s.buy_paths();

    let result =
        s.zap
            .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &100_999_999, &paths);
    assert_eq!(result, Err(Ok(ZapError::SlippageExceeded.into())));

    // Not even the USDC leg fits.
    let result = s
        .zap
        .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &SCALE, &paths);
    assert_eq!(result, Err(Ok(ZapError::SlippageExceeded.into())));

    assert_eq!(
        s.zap
            .issue_with_usdc(&investor, &s.fund.address, &SCALE, &101_000_000, &paths),
        101_000_000
    );
}

#[test]
fn issue_trusts_balances_not_the_router() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    let paths = s.buy_paths();

    s.router.set_flag(&Symbol::new(&s.env, "short"), &true);
    let result =
        s.zap
            .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &(20 * SCALE), &paths);
    assert_eq!(result, Err(Ok(ZapError::SlippageExceeded.into())));

    // A route that overpays leaves the zap with a surplus; it goes to the
    // investor rather than staying behind.
    s.router.set_flag(&Symbol::new(&s.env, "short"), &false);
    s.router.set_flag(&Symbol::new(&s.env, "bonus"), &true);
    s.zap
        .issue_with_usdc(&investor, &s.fund.address, &SCALE, &(20 * SCALE), &paths);
    assert_eq!(s.balance(&s.ustry, &investor), 1);
    assert_eq!(s.balance(&s.xlm, &investor), 1);
    s.assert_zap_holds_nothing();
}

#[test]
fn redeem_sells_every_leg_for_usdc() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    s.issue(&investor, 2 * SCALE, 30 * SCALE);
    let before = s.balance(&s.usdc, &investor);

    let out = s.redeem(&investor, SCALE, 101_000_000);

    assert_eq!(out, 101_000_000);
    assert_eq!(s.balance(&s.usdc, &investor), before + out);
    assert_eq!(s.fund.balance(&investor), SCALE);
    assert_eq!(s.balance(&s.ustry, &investor), 0);
    assert_eq!(s.balance(&s.xlm, &investor), 0);
    s.assert_zap_holds_nothing();
}

#[test]
fn redeem_reverts_under_min_usdc() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    s.issue(&investor, SCALE, 20 * SCALE);
    s.router.set_price(&s.xlm, &900_000);

    let result = s.zap.try_redeem_to_usdc(
        &investor,
        &s.fund.address,
        &SCALE,
        &101_000_000,
        &s.sell_paths(),
    );
    assert_eq!(result, Err(Ok(ZapError::SlippageExceeded.into())));
    assert_eq!(s.fund.balance(&investor), SCALE);

    assert_eq!(s.redeem(&investor, SCALE, 98_000_000), 98_000_000);
}

#[test]
fn redeem_hands_over_legs_too_small_to_swap() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    s.issue(&investor, SCALE, 20 * SCALE);

    // 3 stroops of shares pay 15 USDC, 6 USTRY and 90 XLM stroops; at
    // 0.00001 USDC an XLM, the 90 swap to nothing and go over as they are.
    s.router.set_price(&s.xlm, &100);
    let out = s.redeem(&investor, 3, 0);

    assert_eq!(out, 15 + 6);
    assert_eq!(s.balance(&s.xlm, &investor), 90);
    s.assert_zap_holds_nothing();
}

#[test]
fn paths_must_run_between_usdc_and_each_leg_in_order() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    s.issue(&investor, SCALE, 20 * SCALE);
    let fund = &s.fund.address;
    let max = 20 * SCALE;
    let issue = |paths: Vec<Vec<Address>>| {
        s.zap
            .try_issue_with_usdc(&investor, fund, &SCALE, &max, &paths)
    };
    let redeem = |paths: Vec<Vec<Address>>| {
        s.zap
            .try_redeem_to_usdc(&investor, fund, &SCALE, &0, &paths)
    };
    let invalid = Err(Ok(ZapError::InvalidPath.into()));
    let missing = Err(Ok(ZapError::MissingPath.into()));

    let swapped = vec![
        &s.env,
        s.path(&[&s.usdc, &s.xlm]),
        s.path(&[&s.usdc, &s.ustry]),
    ];
    assert_eq!(issue(swapped), invalid);
    let reversed = vec![
        &s.env,
        s.path(&[&s.ustry, &s.usdc]),
        s.path(&[&s.usdc, &s.xlm]),
    ];
    assert_eq!(issue(reversed), invalid);
    assert_eq!(redeem(s.buy_paths()), invalid);
    let too_long = vec![
        &s.env,
        s.path(&[&s.usdc, &s.xlm, &s.usdc, &s.xlm, &s.ustry]),
        s.path(&[&s.usdc, &s.xlm]),
    ];
    assert_eq!(issue(too_long), invalid);
    let single = vec![&s.env, s.path(&[&s.ustry]), s.path(&[&s.usdc, &s.xlm])];
    assert_eq!(issue(single), invalid);

    assert_eq!(issue(vec![&s.env, s.path(&[&s.usdc, &s.ustry])]), missing);
    let mut extra = s.buy_paths();
    extra.push_back(s.path(&[&s.usdc, &s.xlm]));
    assert_eq!(issue(extra), missing);
    assert_eq!(redeem(Vec::new(&s.env)), missing);

    // A multi-hop route is fine as long as its ends are right.
    let hop = vec![
        &s.env,
        s.path(&[&s.usdc, &s.xlm, &s.ustry]),
        s.path(&[&s.usdc, &s.xlm]),
    ];
    assert!(issue(hop).is_ok());
}

#[test]
fn amounts_must_be_positive() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    let fund = &s.fund.address;
    let invalid = Err(Ok(ZapError::InvalidAmount.into()));
    let buy = s.buy_paths();
    let sell = s.sell_paths();
    assert_eq!(
        s.zap.try_issue_with_usdc(&investor, fund, &0, &SCALE, &buy),
        invalid
    );
    assert_eq!(
        s.zap.try_issue_with_usdc(&investor, fund, &SCALE, &0, &buy),
        invalid
    );
    assert_eq!(
        s.zap.try_redeem_to_usdc(&investor, fund, &0, &0, &sell),
        invalid
    );
    assert_eq!(
        s.zap
            .try_redeem_to_usdc(&investor, fund, &SCALE, &-1, &sell),
        invalid
    );
}

#[test]
fn allowlist_fund_checks_the_investor_never_the_zap() {
    let s = setup(fund::Compliance::Allowlist, false);
    let investor = s.investor(50 * SCALE);
    let paths = s.buy_paths();

    assert!(s
        .zap
        .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &(20 * SCALE), &paths)
        .is_err());
    assert_eq!(s.balance(&s.usdc, &investor), 50 * SCALE);

    s.fund.set_investor(&investor, &true);
    assert_eq!(s.issue(&investor, SCALE, 20 * SCALE), 101_000_000);
    assert!(!s.fund.is_investor(&s.zap.address));
    assert_eq!(s.redeem(&investor, SCALE, 0), 101_000_000);
    s.assert_zap_holds_nothing();
}

#[test]
fn a_permissioned_leg_needs_the_issuer_to_authorize_the_zap() {
    let s = setup(fund::Compliance::Allowlist, true);
    let investor = s.investor(50 * SCALE);
    s.fund.set_investor(&investor, &true);
    let paths = s.buy_paths();

    assert!(s
        .zap
        .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &(20 * SCALE), &paths)
        .is_err());

    StellarAssetClient::new(&s.env, &s.ustry).set_authorized(&s.zap.address, &true);
    assert_eq!(s.issue(&investor, SCALE, 20 * SCALE), 101_000_000);
    assert_eq!(s.redeem(&investor, SCALE, 0), 101_000_000);
}

#[test]
fn only_the_investor_or_owner_signs() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    let paths = s.buy_paths();

    // No signature at all: the zap cannot spend the investor's USDC.
    s.env.mock_auths(&[]);
    assert!(s
        .zap
        .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &(20 * SCALE), &paths)
        .is_err());

    // Someone else's signature does not help either.
    let stranger = Address::generate(&s.env);
    s.sign_only(
        &stranger,
        "issue_with_usdc",
        (
            investor.clone(),
            s.fund.address.clone(),
            SCALE,
            20 * SCALE,
            paths.clone(),
        )
            .into_val(&s.env),
    );
    assert!(s
        .zap
        .try_issue_with_usdc(&investor, &s.fund.address, &SCALE, &(20 * SCALE), &paths)
        .is_err());

    s.env.mock_all_auths();
    s.issue(&investor, SCALE, 20 * SCALE);
    s.env.mock_auths(&[]);
    assert!(s
        .zap
        .try_redeem_to_usdc(&investor, &s.fund.address, &SCALE, &0, &s.sell_paths())
        .is_err());
    s.env.mock_all_auths();
    assert_eq!(s.fund.balance(&investor), SCALE);
    assert_eq!(s.fund.balance(&s.manager), 0);
}

#[test]
fn emits_one_event_per_zap() {
    let s = open();
    let investor = s.investor(50 * SCALE);
    s.issue(&investor, SCALE, 20 * SCALE);
    let issued = s.env.events().all().filter_by_contract(&s.zap.address);
    assert_eq!(issued.events().len(), 1);

    s.redeem(&investor, SCALE, 0);
    let redeemed = s.env.events().all().filter_by_contract(&s.zap.address);
    assert_eq!(redeemed.events().len(), 1);
}
