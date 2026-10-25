use soroban_sdk::{contractevent, Address, Vec};

use crate::storage::Compliance;

#[contractevent(topics = ["transfer"], data_format = "single-value")]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["mint"], data_format = "single-value")]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["burn"], data_format = "single-value")]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["approve"], data_format = "vec")]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contractevent(topics = ["issue"])]
pub struct Issue {
    #[topic]
    pub investor: Address,
    #[topic]
    pub to: Address,
    pub shares: i128,
    pub amounts: Vec<i128>,
}

#[contractevent(topics = ["redeem"])]
pub struct Redeem {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub shares: i128,
    pub amounts: Vec<i128>,
}

#[contractevent(topics = ["withdraw_owed"])]
pub struct WithdrawOwed {
    #[topic]
    pub owner: Address,
    #[topic]
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["investor_set"])]
pub struct InvestorSet {
    #[topic]
    pub investor: Address,
    pub allowed: bool,
}

#[contractevent(topics = ["compliance_set"], data_format = "single-value")]
pub struct ComplianceSet {
    pub compliance: Compliance,
}

#[contractevent(topics = ["manager_set"])]
pub struct ManagerSet {
    #[topic]
    pub previous: Address,
    #[topic]
    pub manager: Address,
}
