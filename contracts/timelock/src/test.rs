extern crate std;

use alloy_nav::{Nav, NavClient};
use alloy_platform::{Platform, PlatformClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

use crate::{
    CancelBy, Timelock, TimelockClient, TimelockError, GRACE_PERIOD_SECONDS, MAX_DELAY_SECONDS,
    MIN_DELAY_FLOOR_SECONDS,
};

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
            MIN_DELAY_FLOOR_SECONDS,
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
            MIN_DELAY_FLOOR_SECONDS,
        ),
    );
}

fn register_with_delays(delay: u64, min_delay: u64) -> u64 {
    let env = Env::default();
    let roles = vec![&env, Address::generate(&env)];
    let id = env.register(Timelock, (roles.clone(), roles, delay, min_delay));
    TimelockClient::new(&env, &id).min_delay()
}

#[test]
fn construction_takes_a_minimum_delay_of_at_least_five_minutes() {
    assert_eq!(
        register_with_delays(MIN_DELAY_FLOOR_SECONDS, MIN_DELAY_FLOOR_SECONDS),
        MIN_DELAY_FLOOR_SECONDS
    );
    assert_eq!(register_with_delays(DELAY, DELAY), DELAY);
}

#[test]
#[should_panic]
fn construction_refuses_a_minimum_under_the_floor() {
    register_with_delays(DELAY, MIN_DELAY_FLOOR_SECONDS - 1);
}

#[test]
#[should_panic]
fn construction_refuses_a_delay_under_the_minimum() {
    register_with_delays(DELAY - 1, DELAY);
}

// Regressions for the v0.5 contract audit (AUD-08): the audit's proofs,
// turned around to assert the fix.

/// The audit scheduled `set_delay(0)` and then ran every later operation
/// immediately. The delay now never drops below the construction minimum.
#[test]
fn delay_never_drops_below_the_minimum() {
    let s = setup();
    s.env.mock_all_auths();
    let target = s.timelock.address.clone();
    let fn_name = Symbol::new(&s.env, "set_delay");
    for (n, delay) in [(1u8, 0u64), (2, MIN_DELAY_FLOOR_SECONDS - 1)] {
        let args: Vec<Val> = vec![&s.env, delay.into_val(&s.env)];
        s.timelock
            .schedule(&s.proposer, &target, &fn_name, &args, &salt(&s.env, n));
        later(&s, DELAY);
        assert_eq!(
            failure(s.timelock.try_execute(
                &s.executor,
                &target,
                &fn_name,
                &args,
                &salt(&s.env, n)
            )),
            Some(TimelockError::InvalidDelay.into())
        );
    }
    run(
        &s,
        &target,
        "set_delay",
        vec![&s.env, MIN_DELAY_FLOOR_SECONDS.into_val(&s.env)],
        3,
    );
    assert_eq!(s.timelock.delay(), MIN_DELAY_FLOOR_SECONDS);
}

/// The audit executed an operation five years after scheduling it. A ready
/// operation now expires after the grace period.
#[test]
fn operations_expire_after_the_grace_period() {
    let s = setup();
    hand_platform_to_timelock(&s);
    s.env.mock_all_auths();
    let fn_name = Symbol::new(&s.env, "set_manager");
    let args: Vec<Val> = vec![
        &s.env,
        Address::generate(&s.env).to_val(),
        true.into_val(&s.env),
    ];
    for n in [7u8, 8] {
        s.timelock.schedule(
            &s.proposer,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, n),
        );
    }
    later(&s, DELAY + GRACE_PERIOD_SECONDS);
    s.timelock.execute(
        &s.executor,
        &s.platform.address,
        &fn_name,
        &args,
        &salt(&s.env, 7),
    );
    later(&s, 1);
    assert_eq!(
        failure(s.timelock.try_execute(
            &s.executor,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 8)
        )),
        Some(TimelockError::Expired.into())
    );
    let id = s
        .timelock
        .hash_operation(&s.platform.address, &fn_name, &args, &salt(&s.env, 8));
    s.timelock.cancel(&s.proposer, &id);
    assert_eq!(s.timelock.operation(&id), None);
}

/// Roles were fixed for life, so a lost or stolen key could never be
/// rotated out. They now change through scheduled self-calls.
#[test]
fn roles_rotate_only_through_scheduled_self_calls() {
    let s = setup();
    s.env.mock_all_auths();
    let target = s.timelock.address.clone();
    let (proposer, executor) = (Address::generate(&s.env), Address::generate(&s.env));
    let rotations = [
        ("set_proposers", proposer.clone()),
        ("set_executors", executor.clone()),
    ];
    for (n, (fn_name, member)) in rotations.iter().enumerate() {
        let args: Vec<Val> = vec![&s.env, vec![&s.env, member.clone()].to_val()];
        s.timelock.schedule(
            &s.proposer,
            &target,
            &Symbol::new(&s.env, fn_name),
            &args,
            &salt(&s.env, n as u8),
        );
    }
    later(&s, DELAY);
    for (n, (fn_name, member)) in rotations.iter().enumerate() {
        let args: Vec<Val> = vec![&s.env, vec![&s.env, member.clone()].to_val()];
        s.timelock.execute(
            &s.executor,
            &target,
            &Symbol::new(&s.env, fn_name),
            &args,
            &salt(&s.env, n as u8),
        );
    }
    assert_eq!(s.timelock.proposers(), vec![&s.env, proposer.clone()]);
    assert_eq!(s.timelock.executors(), vec![&s.env, executor.clone()]);

    let fn_name = symbol_short!("admin");
    let args: Vec<Val> = Vec::new(&s.env);
    assert_eq!(
        s.timelock.try_schedule(
            &s.proposer,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 3)
        ),
        Err(Ok(TimelockError::NotProposer.into()))
    );
    s.timelock.schedule(
        &proposer,
        &s.platform.address,
        &fn_name,
        &args,
        &salt(&s.env, 3),
    );
    later(&s, DELAY);
    assert_eq!(
        failure(s.timelock.try_execute(
            &s.executor,
            &s.platform.address,
            &fn_name,
            &args,
            &salt(&s.env, 3)
        )),
        Some(TimelockError::NotExecutor.into())
    );
    s.timelock.execute(
        &executor,
        &s.platform.address,
        &fn_name,
        &args,
        &salt(&s.env, 3),
    );

    // An empty list would lock the timelock for good.
    let set_proposers = Symbol::new(&s.env, "set_proposers");
    let empty: Vec<Val> = vec![&s.env, Vec::<Address>::new(&s.env).to_val()];
    s.timelock
        .schedule(&proposer, &target, &set_proposers, &empty, &salt(&s.env, 4));
    later(&s, DELAY);
    assert_eq!(
        failure(s.timelock.try_execute(
            &executor,
            &target,
            &set_proposers,
            &empty,
            &salt(&s.env, 4)
        )),
        Some(TimelockError::InvalidRoles.into())
    );
}

/// A compromised proposer used to be able to cancel any operation, so it
/// could cancel its own removal forever. A role change can now be
/// cancelled only by the proposer who scheduled it, never by one it
/// removes; ordinary operations keep every proposer's veto.
#[test]
fn a_hostile_proposer_cannot_block_its_own_removal() {
    let env = Env::default();
    env.ledger().set_timestamp(1_000_000);
    env.mock_all_auths();
    let (honest, hostile, executor) = (
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    );
    let timelock = TimelockClient::new(
        &env,
        &env.register(
            Timelock,
            (
                vec![&env, honest.clone(), hostile.clone()],
                vec![&env, executor.clone()],
                DELAY,
                MIN_DELAY_FLOOR_SECONDS,
            ),
        ),
    );
    let me = timelock.address.clone();
    let set_proposers = Symbol::new(&env, "set_proposers");
    let to = |list: Vec<Address>| -> Vec<Val> { vec![&env, list.to_val()] };
    let cannot = Err(Ok(TimelockError::CannotCancel.into()));

    let removal = to(vec![&env, honest.clone()]);
    let id = timelock.schedule(&honest, &me, &set_proposers, &removal, &salt(&env, 1));
    let op = timelock.operation(&id).unwrap();
    assert_eq!(op.proposer, honest);
    assert_eq!(op.cancel_by, CancelBy::Scheduler);
    assert_eq!(timelock.try_cancel(&hostile, &id), cannot);

    // The hostile proposer's ordinary operations stay under the honest veto.
    let target = Address::generate(&env);
    let takeover = vec![&env, hostile.to_val()];
    let set_admin = Symbol::new(&env, "set_admin");
    let bad = timelock.schedule(&hostile, &target, &set_admin, &takeover, &salt(&env, 2));
    timelock.cancel(&honest, &bad);

    // Its counter-rotation cannot be cancelled by the honest side either;
    // the executors decide which runs.
    let counter = to(vec![&env, hostile.clone()]);
    let counter_id = timelock.schedule(&hostile, &me, &set_proposers, &counter, &salt(&env, 3));
    assert_eq!(timelock.try_cancel(&honest, &counter_id), cannot);

    env.ledger().set_timestamp(1_000_000 + DELAY);
    timelock.execute(&executor, &me, &set_proposers, &removal, &salt(&env, 1));
    assert_eq!(timelock.proposers(), vec![&env, honest.clone()]);
    assert_eq!(
        timelock.try_cancel(&hostile, &counter_id),
        Err(Ok(TimelockError::NotProposer.into()))
    );
    assert_eq!(
        timelock.try_schedule(&hostile, &me, &set_proposers, &counter, &salt(&env, 4)),
        Err(Ok(TimelockError::NotProposer.into()))
    );

    // Scheduling one's own removal is final: nobody can cancel it.
    let leave = to(vec![&env, Address::generate(&env)]);
    let leave_id = timelock.schedule(&honest, &me, &set_proposers, &leave, &salt(&env, 5));
    assert_eq!(
        timelock.operation(&leave_id).unwrap().cancel_by,
        CancelBy::Nobody
    );
    assert_eq!(timelock.try_cancel(&honest, &leave_id), cannot);
}
