//! Alloy platform: the only door through which funds are created.
//!
//! The admin (a timelock in production) curates which managers may create
//! funds and which assets may sit in them. A `Permissioned` shelf asset is one
//! whose issuer gates holders (`AUTH_REQUIRED`, as with BENJI); any fund that
//! holds one must run its own investor allowlist so the fund never admits a
//! holder the issuer would refuse.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, ContractExecutable, Env, String, Vec,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const ENTRY_BUMP: u32 = 60 * DAY_IN_LEDGERS;
const ENTRY_THRESHOLD: u32 = ENTRY_BUMP - DAY_IN_LEDGERS;

/// Mirrors `alloy_fund::Component`; identical field names give identical XDR.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub token: Address,
    pub initial_units: i128,
}

/// Mirrors `alloy_fund::Compliance`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Compliance {
    Open,
    Allowlist,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShelfStatus {
    Unlisted,
    Open,
    Permissioned,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PlatformError {
    NotManager = 1,
    NotOnShelf = 2,
    PermissionedNeedsAllowlist = 3,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    FundWasm,
    Funds,
    Shelf,
    Manager(Address),
    ShelfStatus(Address),
    IsFund(Address),
}

#[contractevent(topics = ["fund_created"])]
pub struct FundCreated {
    #[topic]
    pub fund: Address,
    #[topic]
    pub manager: Address,
    pub components: Vec<Component>,
    pub compliance: Compliance,
}

#[contractevent(topics = ["manager_set"])]
pub struct ManagerSet {
    #[topic]
    pub manager: Address,
    pub allowed: bool,
}

#[contractevent(topics = ["shelf_set"])]
pub struct ShelfSet {
    #[topic]
    pub token: Address,
    pub status: ShelfStatus,
}

#[contractevent(topics = ["admin_set"])]
pub struct AdminSet {
    #[topic]
    pub previous: Address,
    #[topic]
    pub admin: Address,
}

#[contractevent(topics = ["fund_wasm_set"], data_format = "single-value")]
pub struct FundWasmSet {
    pub wasm_hash: BytesN<32>,
}

#[contract]
pub struct Platform;

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn require_admin(env: &Env) {
    admin(env).require_auth();
    bump_instance(env);
}

fn read_list(env: &Env, key: &DataKey) -> Vec<Address> {
    let storage = env.storage().persistent();
    match storage.get(key) {
        Some(list) => {
            storage.extend_ttl(key, ENTRY_THRESHOLD, ENTRY_BUMP);
            list
        }
        None => Vec::new(env),
    }
}

fn write_list(env: &Env, key: &DataKey, list: &Vec<Address>) {
    let storage = env.storage().persistent();
    storage.set(key, list);
    storage.extend_ttl(key, ENTRY_THRESHOLD, ENTRY_BUMP);
}

fn shelf_status(env: &Env, token: &Address) -> ShelfStatus {
    let key = DataKey::ShelfStatus(token.clone());
    let storage = env.storage().persistent();
    match storage.get(&key) {
        Some(status) => {
            storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
            status
        }
        None => ShelfStatus::Unlisted,
    }
}

fn is_manager(env: &Env, manager: &Address) -> bool {
    let key = DataKey::Manager(manager.clone());
    let storage = env.storage().persistent();
    let allowed = storage.has(&key);
    if allowed {
        storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
    }
    allowed
}

#[contractimpl]
impl Platform {
    pub fn __constructor(env: Env, admin: Address, fund_wasm: BytesN<32>) {
        let instance = env.storage().instance();
        instance.set(&DataKey::Admin, &admin);
        instance.set(&DataKey::FundWasm, &fund_wasm);
        bump_instance(&env);
    }

    /// Deploys a fund. Every component must be on the shelf; a fund holding a
    /// permissioned asset must gate its own investors.
    pub fn create_fund(
        env: Env,
        manager: Address,
        name: String,
        symbol: String,
        components: Vec<Component>,
        compliance: Compliance,
        salt: BytesN<32>,
    ) -> Address {
        manager.require_auth();
        bump_instance(&env);
        if !is_manager(&env, &manager) {
            panic_with_error!(&env, PlatformError::NotManager);
        }
        for component in components.iter() {
            match shelf_status(&env, &component.token) {
                ShelfStatus::Unlisted => panic_with_error!(&env, PlatformError::NotOnShelf),
                ShelfStatus::Permissioned if compliance != Compliance::Allowlist => {
                    panic_with_error!(&env, PlatformError::PermissionedNeedsAllowlist)
                }
                _ => {}
            }
        }

        let wasm: BytesN<32> = env.storage().instance().get(&DataKey::FundWasm).unwrap();
        let fund = env.deployer().with_current_contract(salt).deploy_contract(
            ContractExecutable::Wasm(wasm),
            (
                env.current_contract_address(),
                manager.clone(),
                name,
                symbol,
                components.clone(),
                compliance,
            ),
        );

        let mut funds = read_list(&env, &DataKey::Funds);
        funds.push_back(fund.clone());
        write_list(&env, &DataKey::Funds, &funds);
        let key = DataKey::IsFund(fund.clone());
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);

        FundCreated {
            fund: fund.clone(),
            manager,
            components,
            compliance,
        }
        .publish(&env);
        fund
    }

    pub fn set_manager(env: Env, manager: Address, allowed: bool) {
        require_admin(&env);
        let key = DataKey::Manager(manager.clone());
        let storage = env.storage().persistent();
        if allowed {
            storage.set(&key, &true);
            storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
        } else {
            storage.remove(&key);
        }
        ManagerSet { manager, allowed }.publish(&env);
    }

    /// Lists, reclassifies or delists an asset. Delisting blocks new funds
    /// from holding it; funds that already hold it keep redeeming it.
    pub fn set_shelf_asset(env: Env, token: Address, status: ShelfStatus) {
        require_admin(&env);
        let key = DataKey::ShelfStatus(token.clone());
        let storage = env.storage().persistent();
        let mut shelf = read_list(&env, &DataKey::Shelf);
        let listed = shelf.first_index_of(&token);
        match (status, listed) {
            (ShelfStatus::Unlisted, Some(index)) => {
                shelf.remove(index);
                storage.remove(&key);
            }
            (ShelfStatus::Unlisted, None) => {}
            (_, existing) => {
                if existing.is_none() {
                    shelf.push_back(token.clone());
                }
                storage.set(&key, &status);
                storage.extend_ttl(&key, ENTRY_THRESHOLD, ENTRY_BUMP);
            }
        }
        write_list(&env, &DataKey::Shelf, &shelf);
        ShelfSet { token, status }.publish(&env);
    }

    pub fn set_fund_wasm(env: Env, wasm_hash: BytesN<32>) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::FundWasm, &wasm_hash);
        FundWasmSet { wasm_hash }.publish(&env);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let previous = admin(&env);
        previous.require_auth();
        new_admin.require_auth();
        bump_instance(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        AdminSet {
            previous,
            admin: new_admin,
        }
        .publish(&env);
    }

    pub fn admin(env: Env) -> Address {
        admin(&env)
    }

    pub fn fund_wasm(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::FundWasm).unwrap()
    }

    /// The authority on whether a fund is genuine. A contract can name this
    /// platform in its own storage; only funds created here return true.
    pub fn is_fund(env: Env, fund: Address) -> bool {
        env.storage().persistent().has(&DataKey::IsFund(fund))
    }

    pub fn funds(env: Env) -> Vec<Address> {
        read_list(&env, &DataKey::Funds)
    }

    pub fn shelf(env: Env) -> Vec<Address> {
        read_list(&env, &DataKey::Shelf)
    }

    pub fn shelf_status(env: Env, token: Address) -> ShelfStatus {
        shelf_status(&env, &token)
    }

    pub fn is_manager(env: Env, manager: Address) -> bool {
        is_manager(&env, &manager)
    }
}

#[cfg(test)]
mod test;
