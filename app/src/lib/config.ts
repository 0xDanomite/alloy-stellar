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

function firstAvailable(candidates: (string | null | undefined)[]): Network {
  const valid = candidates.find((n): n is Network => availableNetworks.includes(n as Network));
  return valid ?? availableNetworks[0] ?? "testnet";
}

const linkedNetwork = new URLSearchParams(window.location.search).get("network");

/** The network this visitor would be on without the link's `?network=`. */
export const usualNetwork: Network = firstAvailable([storedNetwork(), import.meta.env.VITE_NETWORK]);

/** Chosen once per page load; switching reloads so no module mixes networks. */
export const network: Network = firstAvailable([linkedNetwork, usualNetwork]);

/** True when a link's `?network=` moved this visitor off their usual network, which they should confirm. */
export const networkFromLink: boolean = network !== usualNetwork;

export const NETWORK_NAME: Record<Network, string> = { mainnet: "Stellar Mainnet", testnet: "Testnet" };

/** Keeps the network a link chose, as if picked by hand, without reloading. */
export function keepLinkedNetwork() {
  try {
    localStorage.setItem(NETWORK_KEY, network);
  } catch {
    // Without storage the choice still rides on the URL.
  }
}

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
  "a85d6d53dfe894ef6483aad0613359584e5a78629c159cf3dbf53d74395a0404": "v0.4.0",
  "7d35c015a4abcfade8a6aed3c984f52d6fec44d3edaf604f4f8441f1033f0b5d": "v0.4.0",
};

export function fundRelease(wasmHash: string | null): { tag: string; url: string } | null {
  const tag = wasmHash ? FUND_RELEASES[wasmHash] : undefined;
  return tag ? { tag, url: `${links.repo}/releases/tag/${tag}` } : null;
}

/**
 * Fund code released before v0.4, which has no fee, mandate, metadata,
 * issuance gate or Soroswap trade. Unlisted hashes are left to a probe.
 */
export function isLegacyFundCode(wasmHash: string | null): boolean {
  const tag = wasmHash ? FUND_RELEASES[wasmHash] : undefined;
  return tag !== undefined && /^v0\.[0-3]\./.test(tag);
}

/**
 * A second platform deployed with fund v0.4 code, read from
 * `deployments/<network>-v4.json` when that file exists. Its funds list
 * alongside the first platform's, and new funds are created on it.
 */
export interface PlatformDeployment {
  contracts: { platform: string; nav?: string; funds?: Record<string, string>; zap?: string };
}

export interface PlatformSlot {
  id: string;
  /** The NAV contract this platform's funds are priced by. */
  nav: string | null;
  /** Launch funds by symbol: they list first and keep their short symbol. */
  launched: Record<string, string>;
  /** The USDC zap deployed alongside this platform, for one-signature investing and redeeming. */
  zap: string | null;
}

const v4Deployment = files[`../../../deployments/${network}-v4.json`] as PlatformDeployment | undefined;
const demoDeployment = files[`../../../deployments/${network}-demo.json`] as PlatformDeployment | undefined;

const primarySlot: PlatformSlot | null = deployments
  ? { id: deployments.contracts.platform, nav: deployments.contracts.nav ?? null, launched: deployments.contracts.funds, zap: null }
  : null;

const v4Slot: PlatformSlot | null = v4Deployment
  ? {
      id: v4Deployment.contracts.platform,
      nav: v4Deployment.contracts.nav ?? primarySlot?.nav ?? null,
      launched: v4Deployment.contracts.funds ?? {},
      zap: v4Deployment.contracts.zap ?? null,
    }
  : null;

/** A v0.4 platform kept for live demos, with its own timelock and roles. */
const demoSlot: PlatformSlot | null = demoDeployment
  ? {
      id: demoDeployment.contracts.platform,
      nav: demoDeployment.contracts.nav ?? primarySlot?.nav ?? null,
      launched: demoDeployment.contracts.funds ?? {},
      zap: demoDeployment.contracts.zap ?? null,
    }
  : null;

/** Every platform this build reads funds from: the original first, then the v0.4 ones when deployed. */
export const platforms: PlatformSlot[] = [primarySlot, v4Slot, demoSlot].filter((p): p is PlatformSlot => p !== null);

/** Platforms a manager may create on, newest first. */
export const creationCandidates: PlatformSlot[] = [demoSlot, v4Slot, primarySlot].filter((p): p is PlatformSlot => p !== null);

/** Where new funds are created: the v0.4 platform when deployed, else the original. */
export const creationPlatform: PlatformSlot | null = v4Slot ?? primarySlot;

export function platformSlot(id: string): PlatformSlot | null {
  return platforms.find((p) => p.id === id) ?? null;
}

/** Reflector's mainnet oracle for Stellar assets, quoted in USDC. Its price history lives about a day. */
export const REFLECTOR_ORACLE: string | null =
  network === "mainnet" ? "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M" : null;

/** Soroswap's router, as published in soroswap/core; v0.4 mainnet fund builds compile it in. */
export const SOROSWAP_ROUTER: string | null =
  network === "mainnet" ? "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH" : null;

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
