//! Per-network defaults compiled in with the `mainnet` or `testnet` feature.
//! An address the platform admin sets on the fund always wins over these.

#[cfg(feature = "mainnet")]
pub(crate) const DEFAULT_NAV: Option<&str> =
    Some("CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC");

#[cfg(not(feature = "mainnet"))]
pub(crate) const DEFAULT_NAV: Option<&str> = None;

/// Soroswap router, wasm hash 4c3db3eb...ba07 on mainnet and 4b95bbf9...824c
/// on testnet, as published in soroswap/core `public/*.contracts.json`.
#[cfg(feature = "mainnet")]
pub(crate) const DEFAULT_ROUTER: Option<&str> =
    Some("CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH");

#[cfg(all(feature = "testnet", not(feature = "mainnet")))]
pub(crate) const DEFAULT_ROUTER: Option<&str> =
    Some("CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD");

#[cfg(not(any(feature = "mainnet", feature = "testnet")))]
pub(crate) const DEFAULT_ROUTER: Option<&str> = None;
