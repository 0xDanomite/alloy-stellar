//! Alloy timelock: the admin the platform and NAV contracts answer to.
//!
//! A proposer schedules a call (target contract, function, arguments, salt);
//! once the delay has passed, an executor runs it, and the timelock makes the
//! call itself. Because the timelock is the direct caller, a target that
//! checks `admin.require_auth()` accepts it with no signature scheme of its
//! own. Anyone watching the `scheduled` events has the full delay to react
//! before an admin change lands.
//!
//! Roles are fixed at construction. The delay can only change through a
//! scheduled call to the timelock itself, so it is subject to the delay it
//! replaces.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    xdr::ToXdr, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const ENTRY_BUMP: u32 = 60 * DAY_IN_LEDGERS;
const ENTRY_THRESHOLD: u32 = ENTRY_BUMP - DAY_IN_LEDGERS;

/// Longest allowed delay: 30 days, so a bad update can't freeze the admin.
pub const MAX_DELAY_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const MAX_ROLE_MEMBERS: u32 = 10;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TimelockError {
    NotProposer = 1,
    NotExecutor = 2,
    AlreadyScheduled = 3,
    UnknownOperation = 4,
    NotReady = 5,
    AlreadyDone = 6,
    InvalidDelay = 7,
    UnsupportedSelfCall = 8,
    InvalidRoles = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Operation {
    pub ready_at: u64,
    pub done: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Proposers,
    Executors,
    Delay,
    Operation(BytesN<32>),
}

#[contractevent(topics = ["scheduled"], data_format = "map")]
pub struct Scheduled {
    #[topic]
    pub id: BytesN<32>,
    #[topic]
    pub target: Address,
    pub fn_name: Symbol,
    pub args: Vec<Val>,
    pub salt: BytesN<32>,
    pub ready_at: u64,
    pub proposer: Address,
}

#[contractevent(topics = ["executed"], data_format = "single-value")]
pub struct Executed {
    #[topic]
    pub id: BytesN<32>,
    pub executor: Address,
}

#[contractevent(topics = ["cancelled"], data_format = "single-value")]
pub struct Cancelled {
    #[topic]
    pub id: BytesN<32>,
    pub proposer: Address,
}

#[contractevent(topics = ["delay_set"], data_format = "single-value")]
pub struct DelaySet {
    pub delay: u64,
}

#[contract]
pub struct Timelock;

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn members(env: &Env, key: &DataKey) -> Vec<Address> {
    env.storage().instance().get(key).unwrap()
}

fn require_role(env: &Env, key: &DataKey, who: &Address, error: TimelockError) {
    who.require_auth();
    bump_instance(env);
    if !members(env, key).contains(who) {
        panic_with_error!(env, error);
    }
}

fn check_roles(env: &Env, list: &Vec<Address>) {
    if list.is_empty() || list.len() > MAX_ROLE_MEMBERS {
        panic_with_error!(env, TimelockError::InvalidRoles);
    }
}

fn check_delay(env: &Env, delay: u64) {
    if delay > MAX_DELAY_SECONDS {
        panic_with_error!(env, TimelockError::InvalidDelay);
    }
}

fn delay(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::Delay).unwrap()
}

fn operation(env: &Env, id: &BytesN<32>) -> Option<Operation> {
    let key = DataKey::Operation(id.clone());
    let storage = env.storage().persistent();
    let op = storage.get(&key);
    if op.is_some() {
        storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
    }
    op
}

fn write_operation(env: &Env, id: &BytesN<32>, op: &Operation) {
    let key = DataKey::Operation(id.clone());
    let storage = env.storage().persistent();
    storage.set(&key, op);
    storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
}

fn hash_operation(
    env: &Env,
    target: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    salt: &BytesN<32>,
) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.append(&target.clone().to_xdr(env));
    preimage.append(&fn_name.clone().to_xdr(env));
    preimage.append(&args.clone().to_xdr(env));
    preimage.append(&Bytes::from(salt.clone()));
    env.crypto().sha256(&preimage).into()
}

/// A contract cannot call itself, so calls aimed at the timelock run here.
fn call_self(env: &Env, fn_name: &Symbol, args: &Vec<Val>) -> Val {
    if *fn_name == Symbol::new(env, "set_delay") && args.len() == 1 {
        let new_delay = u64::try_from_val(env, &args.get_unchecked(0))
            .unwrap_or_else(|_| panic_with_error!(env, TimelockError::UnsupportedSelfCall));
        check_delay(env, new_delay);
        env.storage().instance().set(&DataKey::Delay, &new_delay);
        DelaySet { delay: new_delay }.publish(env);
        return Val::VOID.into();
    }
    panic_with_error!(env, TimelockError::UnsupportedSelfCall)
}

#[contractimpl]
impl Timelock {
    pub fn __constructor(env: Env, proposers: Vec<Address>, executors: Vec<Address>, delay: u64) {
        check_roles(&env, &proposers);
        check_roles(&env, &executors);
        check_delay(&env, delay);
        let instance = env.storage().instance();
        instance.set(&DataKey::Proposers, &proposers);
        instance.set(&DataKey::Executors, &executors);
        instance.set(&DataKey::Delay, &delay);
        bump_instance(&env);
    }

    /// Queues `target.fn_name(args)` to run no sooner than the current delay
    /// from now. The salt lets the same call be queued more than once.
    /// Returns the operation id.
    pub fn schedule(
        env: Env,
        proposer: Address,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
        salt: BytesN<32>,
    ) -> BytesN<32> {
        require_role(
            &env,
            &DataKey::Proposers,
            &proposer,
            TimelockError::NotProposer,
        );
        let id = hash_operation(&env, &target, &fn_name, &args, &salt);
        if operation(&env, &id).is_some() {
            panic_with_error!(&env, TimelockError::AlreadyScheduled);
        }
        let ready_at = env.ledger().timestamp() + delay(&env);
        write_operation(
            &env,
            &id,
            &Operation {
                ready_at,
                done: false,
            },
        );
        Scheduled {
            id: id.clone(),
            target,
            fn_name,
            args,
            salt,
            ready_at,
            proposer,
        }
        .publish(&env);
        id
    }

    /// Runs a scheduled call whose delay has passed, with the timelock as the
    /// caller. Each operation runs once. Returns what the target returned.
    pub fn execute(
        env: Env,
        executor: Address,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
        salt: BytesN<32>,
    ) -> Val {
        require_role(
            &env,
            &DataKey::Executors,
            &executor,
            TimelockError::NotExecutor,
        );
        let id = hash_operation(&env, &target, &fn_name, &args, &salt);
        let mut op = operation(&env, &id)
            .unwrap_or_else(|| panic_with_error!(&env, TimelockError::UnknownOperation));
        if op.done {
            panic_with_error!(&env, TimelockError::AlreadyDone);
        }
        if env.ledger().timestamp() < op.ready_at {
            panic_with_error!(&env, TimelockError::NotReady);
        }
        op.done = true;
        write_operation(&env, &id, &op);

        let result = if target == env.current_contract_address() {
            call_self(&env, &fn_name, &args)
        } else {
            env.invoke_contract::<Val>(&target, &fn_name, args)
        };
        Executed { id, executor }.publish(&env);
        result
    }

    /// Drops a pending operation. Executed ones stay recorded so the same
    /// call and salt can never run twice.
    pub fn cancel(env: Env, proposer: Address, id: BytesN<32>) {
        require_role(
            &env,
            &DataKey::Proposers,
            &proposer,
            TimelockError::NotProposer,
        );
        match operation(&env, &id) {
            None => panic_with_error!(&env, TimelockError::UnknownOperation),
            Some(op) if op.done => panic_with_error!(&env, TimelockError::AlreadyDone),
            Some(_) => env
                .storage()
                .persistent()
                .remove(&DataKey::Operation(id.clone())),
        }
        Cancelled { id, proposer }.publish(&env);
    }

    pub fn hash_operation(
        env: Env,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
        salt: BytesN<32>,
    ) -> BytesN<32> {
        hash_operation(&env, &target, &fn_name, &args, &salt)
    }

    pub fn operation(env: Env, id: BytesN<32>) -> Option<Operation> {
        operation(&env, &id)
    }

    pub fn delay(env: Env) -> u64 {
        delay(&env)
    }

    pub fn proposers(env: Env) -> Vec<Address> {
        members(&env, &DataKey::Proposers)
    }

    pub fn executors(env: Env) -> Vec<Address> {
        members(&env, &DataKey::Executors)
    }
}

#[cfg(test)]
mod test;
