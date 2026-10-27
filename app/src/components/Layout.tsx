import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { deployments, keepLinkedNetwork, links, network, NETWORK_NAME, networkFromLink, oracles, switchNetwork, usualNetwork } from "../lib/config";
import { shortId } from "../lib/format";
import { accountRole, adminRoles, type AccountRole } from "../lib/admin";
import { portfolio } from "../lib/portfolio";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { Bell } from "./icons";
import { AlloyMark, Button, ThemeToggle } from "./ui";

const ROLE_DOT: Record<AccountRole, string> = { Admin: "bg-gold", Manager: "bg-primary", Investor: "bg-muted-foreground" };

const ROLE_TITLE: Record<AccountRole, string> = {
  Admin: "administers a platform, directly or through its timelock",
  Manager: "is an approved manager or runs a fund",
  Investor: "invests in funds",
};

/**
 * The wallet button, with the connected wallet's seat beside it so a demo
 * shows at a glance whose wallet is driving. Phones have no room for both,
 * so there the button itself reads the seat and its title keeps the address.
 */
function WalletArea() {
  const { address, connecting, connect, disconnect } = useWallet();
  const role = useAsync(() => accountRole(address ?? ""), deployments && address ? `role:${address}` : null);
  if (!address) {
    return (
      <Button onClick={connect} busy={connecting}>
        <span className="sm:hidden">Connect</span>
        <span className="hidden sm:inline">Connect wallet</span>
      </Button>
    );
  }
  const seat = role.data ?? null;
  return (
    <>
      {seat && (
        <span className="chip content-fade hidden px-2 py-1 text-[0.75rem] text-muted-foreground sm:inline-flex" title={`This wallet ${ROLE_TITLE[seat]}.`}>
          <span className={`size-1.5 rounded-full ${ROLE_DOT[seat]}`} aria-hidden />
          {seat}
        </span>
      )}
      <Button
        variant="secondary"
        onClick={disconnect}
        title={`Connected as ${address}${seat ? `, which ${ROLE_TITLE[seat]}` : ""}. Click to disconnect.`}
      >
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className={`whitespace-nowrap sm:hidden ${seat ? "content-fade" : "num"}`}>{seat ?? shortId(address, 3, 3)}</span>
        <span className="num hidden whitespace-nowrap sm:inline">{shortId(address)}</span>
      </Button>
    </>
  );
}

/**
 * Shown only to the platform admin and timelock proposers or executors: in
 * the header from tablet width up, and in the footer on phones, where the
 * header has no room left.
 */
function AdminLink({ placement }: { placement: "header" | "footer" }) {
  const { address } = useWallet();
  const roles = useAsync(() => adminRoles(address ?? ""), deployments && address ? `admin:${address}` : null);
  if (!roles.data?.length) return null;
  if (placement === "footer") {
    return (
      <Link to="/admin" className="hover:text-foreground sm:hidden">
        Platform admin
      </Link>
    );
  }
  return (
    <NavLink
      to="/admin"
      className={({ isActive }) =>
        `hidden rounded-md px-3 py-2 text-label hover:bg-secondary sm:block ${isActive ? "text-foreground" : "text-muted-foreground"}`
      }
    >
      Admin
    </NavLink>
  );
}

/** Off mainnet, every page says so, so a shared link can't pass testnet off as the real thing. */
function NetworkBadge() {
  if (network === "mainnet") return null;
  return (
    <span className="chip border-warning/50 px-2 py-0.5 text-[0.75rem] text-warning" title={`You are on ${NETWORK_NAME[network]}. Nothing here is real money.`}>
      {NETWORK_NAME[network]}
    </span>
  );
}

/** Asks before a link's `?network=` silently moves the visitor to another network. */
function LinkedNetworkBanner() {
  const [open, setOpen] = useState(networkFromLink);
  if (!open) return null;
  return (
    <div className="border-b border-warning/40 bg-warning-surface" role="alert">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-[0.875rem] sm:px-6">
        <p className="min-w-0 flex-1">
          This link opened {NETWORK_NAME[network]}, not {NETWORK_NAME[usualNetwork]}. Funds and balances here are separate.
        </p>
        <button
          type="button"
          onClick={() => {
            keepLinkedNetwork();
            setOpen(false);
          }}
          className="text-label hover:underline"
        >
          Stay on {NETWORK_NAME[network]}
        </button>
        <button type="button" onClick={() => switchNetwork(usualNetwork)} className="text-label text-primary hover:underline">
          Go to {NETWORK_NAME[usualNetwork]}
        </button>
      </div>
    </div>
  );
}

function AttentionBell() {
  const { address } = useWallet();
  const { pathname } = useLocation();
  const state = useAsync(() => portfolio(address ?? ""), deployments && address ? `${address}:${pathname}` : null);
  if (!address) return null;
  const count = state.data?.attention.length ?? 0;
  const label = count ? `${count} ${count === 1 ? "item needs" : "items need"} attention` : "Nothing needs attention";
  return (
    <Link
      to="/portfolio"
      className="relative grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
      aria-label={`Portfolio: ${label}`}
      title={label}
    >
      <Bell />
      {count > 0 && (
        <span className="num absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-warning px-1 text-[0.625rem] leading-4 font-semibold text-gold-foreground">
          {count}
        </span>
      )}
    </Link>
  );
}

export function Layout() {
  const { error } = useWallet();
  return (
    <div className="relative isolate flex min-h-dvh flex-col">
      <div className="atmosphere pointer-events-none fixed inset-0 -z-10" aria-hidden />
      <header className="sticky top-0 z-20 border-b bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <Link to="/" className="flex items-center gap-2" aria-label="Alloy on Stellar, home">
            <AlloyMark className="h-[18px] w-auto" />
            <span className="hidden text-[0.9375rem] font-semibold tracking-[0.18em] min-[420px]:inline">ALLOY</span>
          </Link>
          <NetworkBadge />
          <nav className="ml-auto flex items-center gap-0.5 sm:gap-1">
            <NavLink
              to="/funds"
              className={({ isActive }) =>
                `rounded-md px-2.5 py-2 text-label hover:bg-secondary sm:px-3 ${isActive ? "text-foreground" : "text-muted-foreground"}`
              }
            >
              Funds
            </NavLink>
            <NavLink
              to="/create"
              className={({ isActive }) =>
                `rounded-md px-2.5 py-2 text-label hover:bg-secondary sm:px-3 ${isActive ? "text-foreground" : "text-muted-foreground"}`
              }
            >
              <span className="sm:hidden">Create</span>
              <span className="hidden sm:inline">Create fund</span>
            </NavLink>
            <NavLink
              to="/portfolio"
              className={({ isActive }) =>
                `hidden rounded-md px-3 py-2 text-label hover:bg-secondary sm:block ${isActive ? "text-foreground" : "text-muted-foreground"}`
              }
            >
              Portfolio
            </NavLink>
            <NavLink
              to="/how"
              className={({ isActive }) =>
                `hidden rounded-md px-3 py-2 text-label hover:bg-secondary lg:block ${isActive ? "text-foreground" : "text-muted-foreground"}`
              }
            >
              How it works
            </NavLink>
            <NavLink
              to="/built"
              className={({ isActive }) =>
                `hidden rounded-md px-3 py-2 text-label hover:bg-secondary lg:block ${isActive ? "text-foreground" : "text-muted-foreground"}`
              }
            >
              What we built
            </NavLink>
            <AdminLink placement="header" />
            <AttentionBell />
            <ThemeToggle />
            <WalletArea />
          </nav>
        </div>
        {error && (
          <p className="mx-auto max-w-6xl px-4 pb-2 text-[0.8125rem] text-destructive sm:px-6" role="alert">
            {error}
          </p>
        )}
        <LinkedNetworkBanner />
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t bg-background/60 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-[0.875rem] text-muted-foreground sm:px-6">
          <span className="flex items-center gap-2">
            <AlloyMark className="h-4 w-auto" />
            Alloy on Stellar, built at HackMeridian 2026
          </span>
          <Link to="/how" className="hover:text-foreground">How it works</Link>
          <Link to="/demo" className="hover:text-foreground">Demo video</Link>
          <Link to="/built" className="hover:text-foreground">What we built</Link>
          <AdminLink placement="footer" />
          <a href={links.repo} target="_blank" rel="noreferrer" className="hover:text-foreground">Source on GitHub</a>
          {links.deck && (
            <a href={links.deck} target="_blank" rel="noreferrer" className="hover:text-foreground">Deck</a>
          )}
          <span>
            Prices:{" "}
            <a href={oracles.redstone.url} target="_blank" rel="noreferrer" className="hover:text-foreground">RedStone</a> and{" "}
            <a href={oracles.reflector.url} target="_blank" rel="noreferrer" className="hover:text-foreground">Reflector</a> oracles
          </span>
          <span className="sm:ml-auto">Unaudited contracts. Small amounts only.</span>
        </div>
      </footer>
    </div>
  );
}
