import { deployments, expert, links, network } from "../lib/config";
import { shortId } from "../lib/format";
import { CopyId } from "../components/ui";
import type { DeploymentTx } from "../lib/config";

const GROUPS: { title: string; blurb: string; match: RegExp }[] = [
  { title: "Platform", blurb: "The registry that deploys funds and decides which managers may create them.", match: /^(deploy platform|upload fund wasm|set fund wasm|allowlist manager)/ },
  { title: "Asset shelf", blurb: "Which assets funds may hold, and which ones need issuer approval.", match: /^(issuer flags|deploy SAC|shelf )/ },
  { title: "Issuer rails", blurb: "Issuers approving holders, and a clawback drill against a live fund.", match: /^(issuer authorizes|clawback|trustline|pay investor)/ },
  { title: "Buying the basket", blurb: "SDEX path payments from XLM into each fund asset.", match: /^buy / },
  { title: "Funds", blurb: "Creating funds, approving investors, issuing and redeeming shares.", match: /^(create fund|allowlist investor|issue |redeem )/ },
];

const PRS = [
  { n: 1, title: "Fund contract: a token that holds a basket, with in-kind issue and redemption no one can stop" },
  { n: 2, title: "Platform contract: manager allowlist, asset shelf and fund creation" },
  { n: 3, title: "One CLI for the whole fund journey, rehearsed on testnet" },
  { n: 4, title: "Mainnet launch: pinned issuers and SDEX basket buys" },
];

function group(txs: DeploymentTx[]) {
  const buckets = GROUPS.map((g) => ({ ...g, txs: [] as DeploymentTx[] }));
  const other: DeploymentTx[] = [];
  for (const tx of txs) {
    const bucket = buckets.find((b) => b.match.test(tx.label));
    (bucket ? bucket.txs : other).push(tx);
  }
  return [...buckets, { title: "Other", blurb: "", match: /$^/, txs: other }].filter((b) => b.txs.length);
}

export function Built() {
  const groups = group(deployments?.txs ?? []);
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
      <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] font-semibold">
        What we built at HackMeridian
      </h1>
      <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-muted-foreground">
        We arrived with Alloy running on two EVM chains and nothing on Stellar. Everything below was written and
        deployed during the hackathon. Each line is a real {network} transaction you can open on Stellar Expert.
      </p>

      {deployments && (
        <div className="mt-8 flex flex-wrap items-center gap-3 text-[0.875rem]">
          <span className="text-muted-foreground">Platform contract</span>
          <CopyId id={deployments.contracts.platform} />
        </div>
      )}

      <div className="mt-12 grid gap-12 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-10">
          {groups.length === 0 && <p className="text-muted-foreground">No transactions recorded for {network} yet.</p>}
          {groups.map((g) => (
            <section key={g.title}>
              <h2 className="text-heading">{g.title}</h2>
              {g.blurb && <p className="mt-1 text-muted-foreground">{g.blurb}</p>}
              <ol className="mt-4 divide-y rounded-lg border bg-card">
                {g.txs.map((tx) => (
                  <li key={tx.hash}>
                    <a
                      href={tx.url || expert.tx(tx.hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-secondary"
                    >
                      <span className="first-letter:uppercase">{tx.label}</span>
                      <span className="num text-[0.8125rem] text-muted-foreground">{shortId(tx.hash, 8, 6)}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>

        <aside>
          <h2 className="text-heading">The code, in four pull requests</h2>
          <ol className="mt-4 space-y-3">
            {PRS.map((pr) => (
              <li key={pr.n}>
                <a
                  href={`${links.repo}/pull/${pr.n}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border bg-card px-4 py-3 hover:border-primary/50"
                >
                  <span className="num text-[0.8125rem] text-muted-foreground">#{pr.n}</span>
                  <span className="mt-0.5 block">{pr.title}</span>
                </a>
              </li>
            ))}
          </ol>
          <a href={links.repo} target="_blank" rel="noreferrer" className="mt-5 inline-block text-label text-primary underline-offset-4 hover:underline">
            Browse the repository
          </a>
        </aside>
      </div>
    </div>
  );
}
