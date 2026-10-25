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

export const network: Network = import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "testnet";

const ENDPOINTS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    expertUrl: "https://stellar.expert/explorer/testnet",
    passphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    expertUrl: "https://stellar.expert/explorer/public",
    passphrase: "Public Global Stellar Network ; September 2015",
  },
} as const;

const env = import.meta.env;

export const endpoints = {
  rpcUrl: env.VITE_RPC_URL || ENDPOINTS[network].rpcUrl,
  horizonUrl: env.VITE_HORIZON_URL || ENDPOINTS[network].horizonUrl,
  expertUrl: ENDPOINTS[network].expertUrl,
  passphrase: ENDPOINTS[network].passphrase,
};

export const deployments: Deployments | null = files[`../../../deployments/${network}.json`] ?? null;

export const links = {
  repo: env.VITE_REPO_URL || "https://github.com/0xDanomite/alloy-stellar",
  deck: env.VITE_DECK_URL || null,
};

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
