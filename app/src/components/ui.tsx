import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { availableNetworks, expert, network, switchNetwork, type Network } from "../lib/config";
import { shortId } from "../lib/format";

const MARK_PATH =
  "M 73 107 H 163 C 185 107 199 114 212 126 L 225 139 C 236 150 247 148 253 136 L 283 77 C 287 69 293 65 302 65 H 345 C 354 65 360 69 364 77 L 468 282 C 476 298 466 309 452 309 H 376 C 366 309 360 304 356 295 L 335 249 C 326 228 316 216 294 216 H 282 C 267 216 257 222 247 232 L 212 267 C 201 278 187 283 168 283 H 73 C 62 283 54 275 54 264 C 54 253 62 245 73 245 H 166 C 181 245 188 241 198 233 L 214 220 C 222 214 231 210 242 208 C 231 206 221 207 208 210 C 199 212 192 213 180 213 H 73 C 62 213 54 205 54 194 C 54 183 62 176 73 176 H 181 C 194 176 201 177 210 179 C 222 182 232 183 242 180 C 231 178 222 175 213 170 L 197 160 C 186 153 177 145 161 145 H 73 C 62 145 54 137 54 126 C 54 115 62 107 73 107 Z";

export function AlloyMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="44 55 434 264" className={className} role="img" aria-label="Alloy">
      <defs>
        <linearGradient id={id} x1="0%" y1="50%" x2="100%" y2="50%">
          <stop offset="0%" style={{ stopColor: "var(--logo-a)" }} />
          <stop offset="55%" style={{ stopColor: "var(--logo-b)" }} />
          <stop offset="100%" style={{ stopColor: "var(--logo-c)" }} />
        </linearGradient>
      </defs>
      <path d={MARK_PATH} fill={`url(#${id})`} />
    </svg>
  );
}

const NETWORK_LABEL: Record<Network, { short: string; long: string }> = {
  mainnet: { short: "Mainnet", long: "Live on Stellar Mainnet" },
  testnet: { short: "Testnet", long: "Testnet" },
};

/** The header's network control: a two-way switch when both deployments exist. */
export function NetworkSwitch() {
  const dot = (n: Network) => (n === "mainnet" ? "bg-gold" : "bg-primary");
  if (availableNetworks.length < 2) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-label whitespace-nowrap">
        <span className={`size-2 rounded-full ${dot(network)}`} aria-hidden />
        <span className="sm:hidden">{NETWORK_LABEL[network].short}</span>
        <span className="hidden sm:inline">{NETWORK_LABEL[network].long}</span>
      </span>
    );
  }
  return (
    <div role="radiogroup" aria-label="Network" className="inline-flex rounded-full border bg-card p-0.5 text-label">
      {availableNetworks.map((n) => {
        const active = n === network;
        return (
          <button
            key={n}
            role="radio"
            aria-checked={active}
            onClick={() => !active && switchNetwork(n)}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 whitespace-nowrap transition-colors sm:gap-2 sm:px-3 ${
              active
                ? n === "mainnet"
                  ? "bg-gold text-gold-foreground"
                  : "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className={`size-2 rounded-full ${active && n === "mainnet" ? "bg-gold-foreground" : dot(n)}`} aria-hidden />
            <span className="sm:hidden">{NETWORK_LABEL[n].short}</span>
            <span className="hidden sm:inline">{active ? NETWORK_LABEL[n].long : NETWORK_LABEL[n].short}</span>
          </button>
        );
      })}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost";

export function Button({
  variant = "primary",
  className = "",
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-primary text-primary-foreground shadow-sm hover:opacity-90",
    secondary: "border bg-card hover:bg-secondary",
    ghost: "hover:bg-secondary",
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-4 text-label transition-[opacity,background-color] disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner() {
  return <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" aria-hidden />;
}

/** A figure that holds its width while loading: no ellipsis, no layout shift. */
export function Figure({ value, width = "6ch", className = "" }: { value: ReactNode | undefined; width?: string; className?: string }) {
  if (value === undefined) return <span className={`skeleton ${className}`} style={{ width }}>0</span>;
  return <span className={`num content-fade ${className}`}>{value}</span>;
}

export function Usd({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value === undefined) return <Figure value={undefined} className={className} />;
  if (value === null) return <span className={`text-muted-foreground ${className}`}>unpriced</span>;
  const [whole, cents] = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 }).split(".");
  return (
    <span className={`num content-fade ${className}`}>
      ${whole}
      <span className="text-[0.6em] text-muted-foreground">.{cents}</span>
    </span>
  );
}

export function CopyId({ id, kind = "contract", head = 6, tail = 6 }: { id: string; kind?: "contract" | "account"; head?: number; tail?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-sm border bg-surface-sunken pl-2 text-[0.8125rem]">
      <a
        href={kind === "contract" ? expert.contract(id) : expert.account(id)}
        target="_blank"
        rel="noreferrer"
        className="num truncate hover:text-primary"
        title={id}
      >
        {shortId(id, head, tail)}
      </a>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(id).then(() => setCopied(true), () => undefined);
        }}
        className="px-2 py-1 text-muted-foreground hover:text-foreground"
        aria-label={`Copy ${id}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export type TxPhase =
  | { state: "idle" }
  | { state: "working"; message: string }
  | { state: "done"; message: string; url?: string }
  | { state: "failed"; message: string };

export function TxNotice({ phase }: { phase: TxPhase }) {
  if (phase.state === "idle") return null;
  const tone =
    phase.state === "failed"
      ? "border-destructive/40 text-destructive"
      : phase.state === "done"
        ? "border-success/40"
        : "border-border";
  return (
    <div role="status" aria-live="polite" className={`content-fade flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card px-3 py-2 text-[0.875rem] ${tone}`}>
      {phase.state === "working" && <Spinner />}
      {phase.state === "done" && <span className="check-draw text-success" aria-hidden>✓</span>}
      <span>{phase.message}</span>
      {phase.state === "done" && phase.url && (
        <a href={phase.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
          View on Stellar Expert
        </a>
      )}
    </div>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("alloy-theme", dark ? "dark" : "light");
    } catch {
      /* storage can be unavailable in private windows */
    }
  }, [dark]);
  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      className="grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        )}
      </svg>
    </button>
  );
}
