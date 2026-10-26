use soroban_sdk::{contractevent, Address, String, Symbol, Vec};

use crate::storage::{Compliance, Mandate};

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
    pub skip: Vec<Address>,
}

#[contractevent(topics = ["leftover_credited"])]
pub struct LeftoverCredited {
    #[topic]
    pub manager: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
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

#[contractevent(topics = ["rebalance"], data_format = "map")]
pub struct Rebalanced {
    #[topic]
    pub manager: Address,
    pub sell: Address,
    pub sold: i128,
    pub buy: Address,
    pub bought: i128,
}

#[contractevent(topics = ["nav_set"], data_format = "single-value")]
pub struct NavSet {
    pub nav: Address,
}

#[contractevent(topics = ["fee_init"], data_format = "single-value")]
pub struct FeeInitialized {
    pub rate_bps: u32,
}

#[contractevent(topics = ["fee_accrued"], data_format = "map")]
pub struct FeeAccrued {
    #[topic]
    pub recipient: Address,
    pub shares: i128,
    pub platform_recipient: Option<Address>,
    pub platform_shares: i128,
}

#[contractevent(topics = ["fee_recipient_set"], data_format = "single-value")]
pub struct FeeRecipientSet {
    pub recipient: Address,
}

#[contractevent(topics = ["platform_fee_set"], data_format = "map")]
pub struct PlatformFeeSet {
    #[topic]
    pub recipient: Address,
    pub share_bps: u32,
}

#[contractevent(topics = ["mandate_set"], data_format = "single-value")]
pub struct MandateSet {
    pub mandate: Mandate,
}

#[contractevent(topics = ["component_added"], data_format = "single-value")]
pub struct ComponentAdded {
    pub token: Address,
}

#[contractevent(topics = ["metadata_set"], data_format = "single-value")]
pub struct MetadataSet {
    #[topic]
    pub key: Symbol,
    pub value: String,
}

#[contractevent(topics = ["issuance_opened"], data_format = "single-value")]
pub struct IssuanceOpened {}

#[contractevent(topics = ["router_set"], data_format = "single-value")]
pub struct RouterSet {
    pub router: Address,
}

#[contractevent(topics = ["trade"], data_format = "map")]
pub struct Traded {
    #[topic]
    pub manager: Address,
    pub router: Address,
    pub sell: Address,
    pub sold: i128,
    pub buy: Address,
    pub bought: i128,
    pub min_bought: i128,
}
