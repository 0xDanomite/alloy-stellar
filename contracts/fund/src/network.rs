//! Per-network defaults compiled in with the `mainnet` or `testnet` feature.
//! An address the platform admin sets on the fund always wins over these.

#[cfg(feature = "mainnet")]
pub(crate) const DEFAULT_NAV: Option<&str> =
    Some("CBO42GCYFZPOM4ITSCKF7DXI7MBL5PMHRL4DBBEZ35HZLOWT76GLZVIC");

#[cfg(not(feature = "mainnet"))]
pub(crate) const DEFAULT_NAV: Option<&str> = None;
