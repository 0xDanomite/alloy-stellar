import type { ReactNode } from "react";

interface Actor {
  title: string;
  body: ReactNode;
}

const APP: Actor = {
  title: "This app",
  body: "Reads the ledger and prepares transactions. Holds nothing: if it vanished, every fund still works.",
};
const MANAGER: Actor = {
  title: "The manager",
  body: "Plans the mix in percentages and signs with their own wallet. No custody, and no way to block your exit.",
};
const PRICES: Actor = {
  title: "Price data",
  body: "Reflector and RedStone oracles. The NAV contract reads them onchain.",
};
const YOU: Actor = {
  title: "You",
  body: "Any Stellar wallet: Freighter, xBull, Lobstr. No account, no broker.",
};
const MARKETS: Actor = {
  title: "Soroswap and the Stellar DEX",
  body: "Public markets the fund trades on.",
};
const FEE: Actor = {
  title: "The manager's fee",
  body: "Accrues as new shares at a rate frozen at launch. The platform may take a share of it, never more on top.",
};
const ADMIN: Actor = {
  title: "Platform admin, via timelock",
  body: "Approves managers and assets. Every change waits in public first. Can't withdraw from a fund or pause redemptions.",
};
const ISSUERS: Actor = {
  title: "Issuer rails",
  body: "Permissioned assets like BENJI: the issuer approves the fund and can claw back. The books follow the balances.",
};

const VAULT_TITLE = "The vault · fully backed";
const VAULT_BODY = "Shares mint only when assets come in. Redeeming returns your exact slice.";
const NAV_LINE = "NAV = Σ holdings × oracle price";

type Flow = "funds" | "signal" | "fee";

const FLOWS: { n: string; text: string; kind: Flow }[] = [
  { n: "①", text: "USDC in, shares out at NAV. One signature through the zap.", kind: "funds" },
  { n: "②", text: "The manager signs a rebalance, in percentages.", kind: "signal" },
  { n: "③", text: "Swaps settle inside the fund, each at least 99% of oracle value.", kind: "funds" },
  { n: "④", text: "The fee mints as new shares.", kind: "fee" },
  { n: "⑤", text: "Your share out, any hour, as USDC or the assets themselves.", kind: "funds" },
];

const FLOW_SWATCH: Record<Flow, string> = {
  funds: "h-[3px] rounded bg-primary",
  signal: "border-t-2 border-dashed border-muted-foreground",
  fee: "h-[3px] rounded bg-warning",
};

function Box({ actor, className = "" }: { actor: Actor; className?: string }) {
  return (
    <div className={`panel rounded-2xl p-3.5 ${className}`}>
      <p className="text-[0.875rem] leading-snug font-medium">{actor.title}</p>
      <p className="mt-1 text-[0.75rem] leading-snug text-muted-foreground">{actor.body}</p>
    </div>
  );
}

function FundToken({ className = "" }: { className?: string }) {
  return (
    <div className={`rounded-2xl border-2 border-primary bg-card p-4 shadow-overlay ${className}`}>
      <p className="font-display text-[1.0625rem] leading-tight font-semibold text-primary">The fund token</p>
      <p className="mt-0.5 text-[0.75rem] text-muted-foreground">SEP-41 · your shares live here</p>
      <div className="mt-3 rounded-xl border border-dashed bg-surface-sunken/60 p-3">
        <p className="text-[0.8125rem] font-medium">{VAULT_TITLE}</p>
        <p className="mt-1 text-[0.75rem] leading-snug text-muted-foreground">
          {VAULT_BODY} <span className="text-foreground">Redemption has no pause switch.</span>
        </p>
      </div>
      <p className="num mt-3 text-[0.75rem] text-muted-foreground">{NAV_LINE}</p>
    </div>
  );
}

function FlowLabel({ className, children }: { className: string; children: ReactNode }) {
  return <p className={`num absolute text-center text-[0.6875rem] leading-tight text-muted-foreground ${className}`}>{children}</p>;
}

export function MapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.75rem] text-muted-foreground">
      <span className="inline-flex items-center gap-2">
        <span className={`inline-block w-6 ${FLOW_SWATCH.funds}`} aria-hidden /> funds move
      </span>
      <span className="inline-flex items-center gap-2">
        <span className={`inline-block w-6 ${FLOW_SWATCH.signal}`} aria-hidden /> signals and authority
      </span>
      <span className="inline-flex items-center gap-2">
        <span className={`inline-block w-6 ${FLOW_SWATCH.fee}`} aria-hidden /> fees, minted as shares
      </span>
    </div>
  );
}

/**
 * The one-picture system map, hand-placed on a fixed 780px canvas. The SVG
 * shares the canvas's coordinates: x is a per-mille of the width, y is pixels.
 */
function DesktopMap() {
  const signal = { strokeDasharray: "5 5", strokeWidth: 1.5, className: "stroke-muted-foreground", markerEnd: "url(#how-signal)" };
  const funds = { strokeWidth: 2.5, className: "stroke-primary", markerEnd: "url(#how-funds)" };
  return (
    <div className="panel relative h-[780px] rounded-2xl">
      <svg viewBox="0 0 1000 780" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <marker id="how-funds" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" className="fill-primary" />
          </marker>
          <marker id="how-signal" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground" />
          </marker>
          <marker id="how-fee" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" className="fill-warning" />
          </marker>
        </defs>
        <line x1="20" y1="226" x2="980" y2="226" strokeDasharray="10 8" strokeWidth="2" className="stroke-foreground/45" />
        <line x1="500" y1="156" x2="500" y2="298" {...signal} />
        <line x1="150" y1="164" x2="335" y2="300" {...signal} />
        <line x1="850" y1="164" x2="665" y2="300" {...signal} />
        <line x1="190" y1="636" x2="335" y2="532" {...signal} />
        <line x1="810" y1="636" x2="665" y2="532" {...signal} />
        <line x1="212" y1="410" x2="326" y2="410" {...funds} />
        <line x1="330" y1="456" x2="216" y2="456" {...funds} />
        <line x1="672" y1="410" x2="786" y2="410" {...funds} />
        <line x1="788" y1="456" x2="674" y2="456" {...funds} />
        <line x1="500" y1="560" x2="500" y2="652" strokeWidth="2.5" className="stroke-warning" markerEnd="url(#how-fee)" />
      </svg>

      <p className="text-filing absolute top-5 left-6 text-muted-foreground">Offchain · people and apps</p>
      <p className="num absolute top-[200px] right-6 text-[0.6875rem] text-muted-foreground">
        the line: everything below keeps working without us
      </p>
      <p className="text-filing absolute top-[240px] left-6 text-muted-foreground">Onchain · Stellar</p>

      <Box actor={APP} className="absolute top-[56px] left-[4%] w-[21%]" />
      <Box actor={MANAGER} className="absolute top-[48px] left-[37%] w-[26%]" />
      <Box actor={PRICES} className="absolute top-[56px] right-[4%] w-[21%]" />

      <Box actor={YOU} className="absolute top-[388px] left-[3%] w-[18%]" />
      <FundToken className="absolute top-[300px] left-[33.5%] w-[33%]" />
      <Box actor={MARKETS} className="absolute top-[388px] right-[3%] w-[18%]" />

      <Box actor={ADMIN} className="absolute top-[640px] left-[3%] w-[27%]" />
      <Box actor={FEE} className="absolute top-[656px] left-[35%] w-[30%]" />
      <Box actor={ISSUERS} className="absolute top-[640px] right-[3%] w-[27%]" />

      <FlowLabel className="top-[352px] left-[21.5%] w-[11.5%]">① USDC in, shares at NAV · one signature</FlowLabel>
      <FlowLabel className="top-[466px] left-[21.5%] w-[11.5%]">⑤ your share out · any hour</FlowLabel>
      <FlowLabel className="top-[258px] left-[51.5%] text-left">② signed rebalance, in percentages</FlowLabel>
      <FlowLabel className="top-[364px] right-[21.5%] w-[11.5%]">③ swaps inside the fund</FlowLabel>
      <FlowLabel className="top-[466px] right-[21.5%] w-[11.5%]">oracle floor 99%</FlowLabel>
      <FlowLabel className="top-[596px] left-[51.5%] text-left">④ fee mints as new shares</FlowLabel>
    </div>
  );
}

/** The same system as a stack: phones can't hold the canvas, but they still get the picture. */
function StackedMap() {
  return (
    <div className="panel rounded-2xl p-4">
      <p className="text-filing text-muted-foreground">Offchain · people and apps</p>
      <div className="mt-3 space-y-2">
        {[APP, MANAGER, PRICES].map((a) => (
          <Box key={a.title} actor={a} />
        ))}
      </div>

      <div className="my-5">
        <div className="border-t-2 border-dashed border-foreground/45" aria-hidden />
        <p className="num mt-2 text-[0.6875rem] text-balance text-muted-foreground">the line: everything below keeps working without us</p>
      </div>

      <p className="text-filing text-muted-foreground">Onchain · Stellar</p>
      <div className="mt-3 space-y-2">
        <Box actor={YOU} />
        <FundToken />
        {[MARKETS, FEE, ADMIN, ISSUERS].map((a) => (
          <Box key={a.title} actor={a} />
        ))}
      </div>

      <ol className="mt-5 space-y-2 border-t pt-4">
        {FLOWS.map((f) => (
          <li key={f.n} className="flex items-start gap-3 text-[0.8125rem]">
            <span className={`mt-[0.6rem] inline-block w-5 shrink-0 ${FLOW_SWATCH[f.kind]}`} aria-hidden />
            <span>
              <span className="num mr-1.5">{f.n}</span>
              <span className="text-muted-foreground">{f.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function SystemMap() {
  return (
    <>
      <div className="hidden lg:block">
        <DesktopMap />
      </div>
      <div className="lg:hidden">
        <StackedMap />
      </div>
      <div className="mt-3 px-1">
        <MapLegend />
      </div>
    </>
  );
}
