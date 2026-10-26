export type Network = "testnet" | "mainnet";

export interface DeploymentAsset {
  asset: string;
  contract: string;
  status: "open" | "permissioned";
  /** Set only for assets we issued ourselves (testnet stand-ins, the demo asset). */
  issuer_identity?: string;
}

export interface DeploymentTx {
  label: string;
  hash: string;
  url: string;
}

export interface Deployments {
  contracts: { platform: string; funds: Record<string, string>; nav?: string };
  assets: Record<string, DeploymentAsset>;
  txs: DeploymentTx[];
}

const files = import.meta.glob<Deployments>("../../../deployments/*.json", {
  eager: true,
  import: "default",
});

const NETWORK_KEY = "alloy.network";

/** Networks this build has a deployment for, mainnet first. */
export const availableNetworks: Network[] = (["mainnet", "testnet"] as const).filter(
  (n) => files[`../../../deployments/${n}.json`] !== undefined,
);

function storedNetwork(): string | null {
  try {
    return localStorage.getItem(NETWORK_KEY);
  } catch {
    return null;
  }
}

function pickNetwork(): Network {
  const wanted = [
    new URLSearchParams(window.location.search).get("network"),
    storedNetwork(),
    import.meta.env.VITE_NETWORK,
  ];
  const valid = wanted.find((n): n is Network => availableNetworks.includes(n as Network));
  return valid ?? availableNetworks[0] ?? "testnet";
}

/** Chosen once per page load; switching reloads so no module mixes networks. */
export const network: Network = pickNetwork();

export function switchNetwork(next: Network) {
  try {
    localStorage.setItem(NETWORK_KEY, next);
  } catch {
    // Without storage the choice still rides on the URL.
  }
  window.location.assign(`/?network=${next}`);
}

const ENDPOINTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    expertUrl: "https://stellar.expert/explorer/testnet",
    passphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    rpcUrl: "https://rpc.lightsail.network",
    horizonUrl: "https://horizon.stellar.org",
    expertUrl: "https://stellar.expert/explorer/public",
    passphrase: "Public Global Stellar Network ; September 2015",
  },
} as const;

const env = import.meta.env;

export const endpoints = {
  rpcUrl: ENDPOINTS[network].rpcUrl,
  horizonUrl: ENDPOINTS[network].horizonUrl,
  expertUrl: ENDPOINTS[network].expertUrl,
  passphrase: ENDPOINTS[network].passphrase,
};

export const deployments: Deployments | null = files[`../../../deployments/${network}.json`] ?? null;

export const links = {
  repo: env.VITE_REPO_URL || "https://github.com/0xDanomite/alloy-stellar",
  deck: env.VITE_DECK_URL || null,
};

/**
 * Fund code hashes matched to the SEP-55 attested GitHub release that first
 * published them; a fund running any other code shows as unmatched.
 */
const FUND_RELEASES: Readonly<Record<string, string>> = {
  "32677e1a2abdbfb57c0f2da513aeed864aa081d604b192cde062f859ff4c446d": "v0.1.0",
  e783b595d4a15c50da44d3a701d2806b64987e01dd1cc041a1c04266efbcd422: "v0.3.0",
};

export function fundRelease(wasmHash: string | null): { tag: string; url: string } | null {
  const tag = wasmHash ? FUND_RELEASES[wasmHash] : undefined;
  return tag ? { tag, url: `${links.repo}/releases/tag/${tag}` } : null;
}

/** Reflector's mainnet oracle for Stellar assets, quoted in USDC. Its price history lives about a day. */
export const REFLECTOR_ORACLE: string | null =
  network === "mainnet" ? "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M" : null;

export const oracles = {
  redstone: { label: "RedStone", url: "https://redstone.finance" },
  reflector: { label: "Reflector", url: "https://reflector.network" },
} as const;

/** The nav contract labels each route with a source symbol. */
export function oracleFor(source: string) {
  return source === "redstone" || source === "reflector" ? oracles[source] : null;
}

export const expert = {
  tx: (hash: string) => `${endpoints.expertUrl}/tx/${hash}`,
  contract: (id: string) => `${endpoints.expertUrl}/contract/${id}`,
  account: (id: string) => `${endpoints.expertUrl}/account/${id}`,
  asset: (code: string, issuer: string) => `${endpoints.expertUrl}/asset/${code}-${issuer}`,
};
