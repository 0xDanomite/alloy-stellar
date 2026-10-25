//! SEP-40 price feed interface, the subset Alloy reads. Shapes checked against
//! the live RedStone and Reflector contracts on mainnet: `lastprice` returns a
//! map `{price: i128, timestamp: u64}` or void.
use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol, U256};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "Sep40Client")]
pub trait Sep40 {
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
    fn decimals(env: Env) -> u32;
}

/// A RedStone per-feed contract on Stellar (one feed per contract, no asset
/// argument), used where its SEP-40 adapter carries no entry. Timestamps are
/// milliseconds; `decimals` is a u64 here, unlike SEP-40.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedPriceData {
    pub price: U256,
    pub package_timestamp: u64,
    pub write_timestamp: u64,
}

#[contractclient(name = "RedStoneFeedClient")]
pub trait RedStoneFeed {
    fn read_price_data(env: Env) -> FeedPriceData;
    fn decimals(env: Env) -> u64;
}
