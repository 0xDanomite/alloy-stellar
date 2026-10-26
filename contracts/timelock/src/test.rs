extern crate std;

use alloy_nav::{Nav, NavClient};
use alloy_platform::{Platform, PlatformClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

use crate::{Timelock, TimelockClient, TimelockError, MAX_DELAY_SECONDS};

const DELAY: u64 = 2 * 24 * 60 * 60;

struct Setup<'a> {
    env: Env,
    timelock: TimelockClient<'a>,
    platform: PlatformClient<'a>,
    admin: Address,
    proposer: Address,
    executor: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(&env);
    let proposer = Address::generate(&env);
    let executor = Address::generate(&env);
    let platform = env.register(
        Platform,
        (admin.clone(), BytesN::from_array(&env, &[0; 32])),
    );
    let timelock = env.register(
        Timelock,
        (
            vec![&env, proposer.clone()],
            vec![&env, executor.clone()],
            DELAY,
        ),
    );
    Setup {
        timelock: TimelockClient::new(&env, &timelock),
        platform: PlatformClient::new(&env, &platform),
        env,
        admin,
        proposer,
        executor,
    }
}

/// The contract error a call failed with, if any; `Val` results don't
/// compare, so `try_execute` results are reduced to this.
fn failure<T, E>(result: Result<T, Result<soroban_sdk::Error, E>>) -> Option<soroban_sdk::Error> {
    result.err().and_then(|error| error.ok())
}

fn salt(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn later(s: &Setup, seconds: u64) {
    let now = s.env.ledger().timestamp();
    s.env.ledger().set_timestamp(now + seconds);
}

/// Schedules and, after the delay, executes `target.fn_name(args)`.
fn run(s: &Setup, target: &Address, fn_name: &str, args: Vec<Val>, n: u8) {
    let fn_name = Symbol::new(&s.env, fn_name);
    s.timelock
        .schedule(&s.proposer, target, &fn_name, &args, &salt(&s.env, n));
    later(s, DELAY);
    s.timelock
        .execute(&s.executor, target, &fn_name, &args, &salt(&s.env, n));
}

/// The timelock takes over the platform through the platform's two-party
/// `set_admin`: the current admin signs for the inner call, and the timelock
/// consents by being the caller.
fn hand_platform_to_timelock(s: &Setup) {
    let fn_name = Symbol::new(&s.env, "set_admin");
    let args: Vec<Val> = vec![&s.env, s.timelock.address.to_val()];
    let salt = salt(&s.env, 1);
    s.env.mock_all_auths();
    s.timelock
        .schedule(&s.proposer, &s.platform.address, &fn_name, &args, &salt);
    later(s, DELAY);
    s.env.mock_auths(&[
        MockAuth {
            address: &s.executor,
            invoke: &MockAuthInvoke {
                contract: &s.timelock.address,
                fn_name: "execute",
                args: (
                    &s.executor,
                    &s.platform.address,
                    fn_name.clone(),
                    args.clone(),
                    salt.clone(),
                )
                    .into_val(&s.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &s.admin,
            invoke: &MockAuthInvoke {
                contract: &s.platform.address,
                fn_name: "set_admin",
                args: (&s.timelock.address,).into_val(&s.env),
                sub_invokes: &[],
            },
        },
    ]);
    s.timelock
        .execute(&s.executor, &s.platform.address, &fn_name, &args, &salt);
}

#[test]
fn timelock_becomes_platform_admin_and_runs_set_manager_after_the_delay() {
    let s = setup();
    hand_platform_to_timelock(&s);
    assert_eq!(s.platform.admin(), s.timelock.address);

    // The old admin key can no longer act.
    let manager = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.admin,
        invoke: &MockAuthInvoke {
            contract: &s.platform.address,
            fn_name: "set_manager",
            args: (&manager, true).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.platform.try_set_manager(&manager, &true).is_err());

    s.env.mock_all_auths();
    let fn_name = Symbol::new(&s.env, "set_manager");
    let args: Vec<Val> = vec![&s.env, manager.to_val(), true.into_val(&s.env)];
    let id = s.timelock.schedule(
        &s.proposer,
        &s.platform.address,
        &fn_name,
        &args,
        &salt(&s.env, 2),
    );
    assert_eq!(
        s.timelock.operation(&id).unwrap().ready_at,
        s.env.ledger().timestamp() + DELAY
    );

    later(&s, DELAY - 1);
    assert_eq!(
        failure(s.timelock.try_execute(
            &s.executor,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 2)
        )),
        Some(TimelockError::NotReady.into())
    );
    assert!(!s.platform.is_manager(&manager));

    later(&s, 1);
    s.timelock.execute(
        &s.executor,
        &s.platform.address,
        &fn_name,
        &args,
        &salt(&s.env, 2),
    );
    assert!(s.platform.is_manager(&manager));
    assert!(s.timelock.operation(&id).unwrap().done);
    assert_eq!(
        failure(s.timelock.try_execute(
            &s.executor,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 2)
        )),
        Some(TimelockError::AlreadyDone.into())
    );
}

#[test]
fn timelock_can_administer_the_nav_contract() {
    let s = setup();
    // The old admin's consent to `set_admin` sits below `execute` in the
    // call tree, as in the platform handover above.
    s.env.mock_all_auths_allowing_non_root_auth();
    let usdc = Address::generate(&s.env);
    let nav = NavClient::new(&s.env, &s.env.register(Nav, (s.admin.clone(), usdc)));
    run(
        &s,
        &nav.address,
        "set_admin",
        vec![&s.env, s.timelock.address.to_val()],
        1,
    );
    assert_eq!(nav.admin(), s.timelock.address);
    let token = Address::generate(&s.env);
    run(
        &s,
        &nav.address,
        "remove_route",
        vec![&s.env, token.to_val()],
        2,
    );
    assert_eq!(nav.primary(&token), None);
}

#[test]
fn only_roles_schedule_execute_and_cancel() {
    let s = setup();
    s.env.mock_all_auths();
    let stranger = Address::generate(&s.env);
    let fn_name = symbol_short!("admin");
    let args: Vec<Val> = Vec::new(&s.env);
    assert_eq!(
        s.timelock.try_schedule(
            &stranger,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 1)
        ),
        Err(Ok(TimelockError::NotProposer.into()))
    );
    let id = s.timelock.schedule(
        &s.proposer,
        &s.platform.address,
        &fn_name,
        &args,
        &salt(&s.env, 1),
    );
    assert_eq!(
        s.timelock.try_schedule(
            &s.proposer,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 1)
        ),
        Err(Ok(TimelockError::AlreadyScheduled.into()))
    );
    later(&s, DELAY);
    for who in [&stranger, &s.proposer] {
        assert_eq!(
            failure(s.timelock.try_execute(
                who,
                &s.platform.address,
                &fn_name,
                &args,
                &salt(&s.env, 1)
            )),
            Some(TimelockError::NotExecutor.into())
        );
    }
    assert_eq!(
        s.timelock.try_cancel(&s.executor, &id),
        Err(Ok(TimelockError::NotProposer.into()))
    );
    s.timelock.cancel(&s.proposer, &id);
    assert_eq!(s.timelock.operation(&id), None);
    assert_eq!(
        failure(s.timelock.try_execute(
            &s.executor,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 1)
        )),
        Some(TimelockError::UnknownOperation.into())
    );
}

#[test]
fn roles_need_real_signatures() {
    let s = setup();
    let fn_name = symbol_short!("admin");
    let args: Vec<Val> = Vec::new(&s.env);
    assert!(s
        .timelock
        .try_schedule(
            &s.proposer,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 1)
        )
        .is_err());
}

#[test]
fn delay_changes_only_through_the_timelock_itself() {
    let s = setup();
    s.env.mock_all_auths();
    let shorter: u64 = 60 * 60;
    let target = s.timelock.address.clone();
    run(
        &s,
        &target,
        "set_delay",
        vec![&s.env, shorter.into_val(&s.env)],
        1,
    );
    assert_eq!(s.timelock.delay(), shorter);

    let too_long = MAX_DELAY_SECONDS + 1;
    let fn_name = Symbol::new(&s.env, "set_delay");
    let args: Vec<Val> = vec![&s.env, too_long.into_val(&s.env)];
    s.timelock
        .schedule(&s.proposer, &target, &fn_name, &args, &salt(&s.env, 2));
    later(&s, shorter);
    assert_eq!(
        failure(
            s.timelock
                .try_execute(&s.executor, &target, &fn_name, &args, &salt(&s.env, 2))
        ),
        Some(TimelockError::InvalidDelay.into())
    );

    let other = symbol_short!("cancel");
    s.timelock.schedule(
        &s.proposer,
        &target,
        &other,
        &Vec::new(&s.env),
        &salt(&s.env, 3),
    );
    later(&s, shorter);
    assert_eq!(
        failure(s.timelock.try_execute(
            &s.executor,
            &target,
            &other,
            &Vec::new(&s.env),
            &salt(&s.env, 3)
        )),
        Some(TimelockError::UnsupportedSelfCall.into())
    );
}

#[test]
#[should_panic]
fn construction_needs_both_roles() {
    let env = Env::default();
    env.register(
        Timelock,
        (
            Vec::<Address>::new(&env),
            vec![&env, Address::generate(&env)],
            DELAY,
        ),
    );
}
