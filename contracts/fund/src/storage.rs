use soroban_sdk::{contracttype, Address, Env, Map, String, Symbol, Vec};

pub(crate) const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const BALANCE_BUMP: u32 = 60 * DAY_IN_LEDGERS;
const BALANCE_THRESHOLD: u32 = BALANCE_BUMP - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Compliance {
    Open,
    Allowlist,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub token: Address,
    pub initial_units: i128,
}

/// `Locked` freezes the basket: no new components, no rebalances, no
/// trades. `Managed` lets the manager re-weight within the oracle bounds and
/// add shelf assets. Chosen once, before the first share exists.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mandate {
    Locked,
    Managed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeState {
    pub rate_bps: u32,
    pub last_accrual: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformFee {
    pub share_bps: u32,
    pub recipient: Address,
}

/// One oracle-measured loss inside the rolling window, in parts per billion
/// of fund value at the time of the trade.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loss {
    pub at: u64,
    pub ppb: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct OwedKey {
    pub owner: Address,
    pub token: Address,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Platform,
    Manager,
    Name,
    Symbol,
    Components,
    Compliance,
    Supply,
    Balance(Address),
    Allowance(AllowanceKey),
    Investor(Address),
    Owed(OwedKey),
    Reserved(Address),
    Nav,
    Fee,
    FeeRecipient,
    PlatformFee,
    Mandate,
    Metadata,
    Losses,
    LastRebalance,
    Opened,
    FeeEscrow(Address),
}

pub(crate) fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

pub(crate) struct Config {
    pub platform: Address,
    pub manager: Address,
    pub name: String,
    pub symbol: String,
    pub components: Vec<Component>,
    pub compliance: Compliance,
}

pub(crate) fn write_config(env: &Env, config: &Config) {
    let instance = env.storage().instance();
    instance.set(&DataKey::Platform, &config.platform);
    instance.set(&DataKey::Manager, &config.manager);
    instance.set(&DataKey::Name, &config.name);
    instance.set(&DataKey::Symbol, &config.symbol);
    instance.set(&DataKey::Components, &config.components);
    instance.set(&DataKey::Compliance, &config.compliance);
    instance.set(&DataKey::Supply, &0i128);
}

fn instance_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> V {
    env.storage().instance().get(key).unwrap()
}

pub(crate) fn platform(env: &Env) -> Address {
    instance_get(env, &DataKey::Platform)
}

pub(crate) fn manager(env: &Env) -> Address {
    instance_get(env, &DataKey::Manager)
}

pub(crate) fn set_manager(env: &Env, manager: &Address) {
    env.storage().instance().set(&DataKey::Manager, manager);
}

pub(crate) fn name(env: &Env) -> String {
    instance_get(env, &DataKey::Name)
}

pub(crate) fn symbol(env: &Env) -> String {
    instance_get(env, &DataKey::Symbol)
}

pub(crate) fn components(env: &Env) -> Vec<Component> {
    instance_get(env, &DataKey::Components)
}

pub(crate) fn compliance(env: &Env) -> Compliance {
    instance_get(env, &DataKey::Compliance)
}

pub(crate) fn set_compliance(env: &Env, compliance: Compliance) {
    env.storage()
        .instance()
        .set(&DataKey::Compliance, &compliance);
}

pub(crate) fn supply(env: &Env) -> i128 {
    instance_get(env, &DataKey::Supply)
}

pub(crate) fn set_supply(env: &Env, supply: i128) {
    env.storage().instance().set(&DataKey::Supply, &supply);
}

fn read_persistent_i128(env: &Env, key: &DataKey) -> i128 {
    let storage = env.storage().persistent();
    match storage.get::<DataKey, i128>(key) {
        Some(value) => {
            storage.extend_ttl(key, BALANCE_THRESHOLD, BALANCE_BUMP);
            value
        }
        None => 0,
    }
}

fn write_persistent_i128(env: &Env, key: &DataKey, value: i128) {
    let storage = env.storage().persistent();
    if value == 0 {
        storage.remove(key);
    } else {
        storage.set(key, &value);
        storage.extend_ttl(key, BALANCE_THRESHOLD, BALANCE_BUMP);
    }
}

pub(crate) fn balance(env: &Env, owner: &Address) -> i128 {
    read_persistent_i128(env, &DataKey::Balance(owner.clone()))
}

pub(crate) fn set_balance(env: &Env, owner: &Address, amount: i128) {
    write_persistent_i128(env, &DataKey::Balance(owner.clone()), amount);
}

pub(crate) fn owed(env: &Env, owner: &Address, token: &Address) -> i128 {
    read_persistent_i128(
        env,
        &DataKey::Owed(OwedKey {
            owner: owner.clone(),
            token: token.clone(),
        }),
    )
}

pub(crate) fn set_owed(env: &Env, owner: &Address, token: &Address, amount: i128) {
    write_persistent_i128(
        env,
        &DataKey::Owed(OwedKey {
            owner: owner.clone(),
            token: token.clone(),
        }),
        amount,
    );
}

pub(crate) fn reserved(env: &Env, token: &Address) -> i128 {
    read_persistent_i128(env, &DataKey::Reserved(token.clone()))
}

pub(crate) fn set_reserved(env: &Env, token: &Address, amount: i128) {
    write_persistent_i128(env, &DataKey::Reserved(token.clone()), amount);
}

pub(crate) fn is_investor(env: &Env, investor: &Address) -> bool {
    let key = DataKey::Investor(investor.clone());
    let storage = env.storage().persistent();
    let allowed = storage.has(&key);
    if allowed {
        storage.extend_ttl(&key, BALANCE_THRESHOLD, BALANCE_BUMP);
    }
    allowed
}

pub(crate) fn set_investor(env: &Env, investor: &Address, allowed: bool) {
    let key = DataKey::Investor(investor.clone());
    let storage = env.storage().persistent();
    if allowed {
        storage.set(&key, &true);
        storage.extend_ttl(&key, BALANCE_THRESHOLD, BALANCE_BUMP);
    } else {
        storage.remove(&key);
    }
}

pub(crate) fn allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceValue {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    match env
        .storage()
        .temporary()
        .get::<DataKey, AllowanceValue>(&key)
    {
        Some(value) if value.expiration_ledger >= env.ledger().sequence() => value,
        _ => AllowanceValue {
            amount: 0,
            expiration_ledger: 0,
        },
    }
}

pub(crate) fn set_allowance(
    env: &Env,
    from: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    let storage = env.storage().temporary();
    storage.set(
        &key,
        &AllowanceValue {
            amount,
            expiration_ledger,
        },
    );
    if amount > 0 {
        let live_for = expiration_ledger
            .checked_sub(env.ledger().sequence())
            .unwrap();
        storage.extend_ttl(&key, live_for, live_for);
    }
}

pub(crate) fn nav(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Nav)
}

pub(crate) fn set_nav(env: &Env, nav: &Address) {
    env.storage().instance().set(&DataKey::Nav, nav);
}

pub(crate) fn fee(env: &Env) -> Option<FeeState> {
    env.storage().instance().get(&DataKey::Fee)
}

pub(crate) fn set_fee(env: &Env, fee: &FeeState) {
    env.storage().instance().set(&DataKey::Fee, fee);
}

pub(crate) fn fee_recipient(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::FeeRecipient)
        .unwrap_or_else(|| manager(env))
}

pub(crate) fn set_fee_recipient(env: &Env, recipient: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::FeeRecipient, recipient);
}

pub(crate) fn platform_fee(env: &Env) -> Option<PlatformFee> {
    env.storage().instance().get(&DataKey::PlatformFee)
}

pub(crate) fn set_platform_fee(env: &Env, fee: &PlatformFee) {
    env.storage().instance().set(&DataKey::PlatformFee, fee);
}

pub(crate) fn mandate(env: &Env) -> Option<Mandate> {
    env.storage().instance().get(&DataKey::Mandate)
}

pub(crate) fn set_mandate(env: &Env, mandate: Mandate) {
    env.storage().instance().set(&DataKey::Mandate, &mandate);
}

pub(crate) fn set_components(env: &Env, components: &Vec<Component>) {
    env.storage()
        .instance()
        .set(&DataKey::Components, components);
}

pub(crate) fn metadata(env: &Env) -> Map<Symbol, String> {
    let storage = env.storage().persistent();
    match storage.get(&DataKey::Metadata) {
        Some(map) => {
            storage.extend_ttl(&DataKey::Metadata, BALANCE_THRESHOLD, BALANCE_BUMP);
            map
        }
        None => Map::new(env),
    }
}

pub(crate) fn set_metadata(env: &Env, map: &Map<Symbol, String>) {
    let storage = env.storage().persistent();
    storage.set(&DataKey::Metadata, map);
    storage.extend_ttl(&DataKey::Metadata, BALANCE_THRESHOLD, BALANCE_BUMP);
}

pub(crate) fn losses(env: &Env) -> Vec<Loss> {
    env.storage()
        .instance()
        .get(&DataKey::Losses)
        .unwrap_or_else(|| Vec::new(env))
}

pub(crate) fn set_losses(env: &Env, losses: &Vec<Loss>) {
    env.storage().instance().set(&DataKey::Losses, losses);
}

pub(crate) fn last_rebalance(env: &Env) -> Option<u64> {
    env.storage().instance().get(&DataKey::LastRebalance)
}

pub(crate) fn set_last_rebalance(env: &Env, at: u64) {
    env.storage().instance().set(&DataKey::LastRebalance, &at);
}

pub(crate) fn is_open(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Opened)
}

pub(crate) fn set_open(env: &Env) {
    env.storage().instance().set(&DataKey::Opened, &true);
}

pub(crate) fn fee_escrow(env: &Env, recipient: &Address) -> i128 {
    read_persistent_i128(env, &DataKey::FeeEscrow(recipient.clone()))
}

pub(crate) fn set_fee_escrow(env: &Env, recipient: &Address, shares: i128) {
    write_persistent_i128(env, &DataKey::FeeEscrow(recipient.clone()), shares);
}
