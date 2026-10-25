/**
 * The only issuer identities the app vouches for. An issuer's home_domain is
 * self-set and proves nothing, so it is never shown as identity. Mainnet only:
 * the same account ID on testnet is a different, unrelated account.
 */
export const PINNED_MAINNET_ISSUERS: Readonly<Record<string, string>> = {
  GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN: "circle.com",
  GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6: "ondo.finance",
  GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC: "etherfuse.com",
  GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5: "franklintempleton.com",
};

/** Circle USDC on mainnet, the pricing numeraire. */
export const CIRCLE_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export const DEMO_ISSUER_LABEL = "demo issuer";
export const UNVERIFIED_ISSUER_LABEL = "unverified issuer";
