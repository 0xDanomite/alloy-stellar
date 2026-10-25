import { Link, NavLink, Outlet } from "react-router-dom";
import { links, oracles } from "../lib/config";
import { shortId } from "../lib/format";
import { useWallet } from "../lib/wallet";
import { AlloyMark, Button, NetworkBadge, ThemeToggle } from "./ui";

function WalletButton() {
  const { address, connecting, connect, disconnect } = useWallet();
  if (address) {
    return (
      <Button variant="secondary" onClick={disconnect} title={`Connected as ${address}. Click to disconnect.`}>
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className="num">{shortId(address)}</span>
      </Button>
    );
  }
  return (
    <Button onClick={connect} busy={connecting}>
      <span className="sm:hidden">Connect</span>
      <span className="hidden sm:inline">Connect wallet</span>
    </Button>
  );
}

export function Layout() {
  const { error } = useWallet();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2" aria-label="Alloy on Stellar, home">
            <AlloyMark className="h-5 w-auto" />
            <span className="font-display text-[1.0625rem] font-semibold">Alloy</span>
          </Link>
          <NetworkBadge />
          <nav className="ml-auto flex items-center gap-1">
            <NavLink
              to="/built"
              className={({ isActive }) =>
                `hidden rounded-md px-3 py-2 text-label hover:bg-secondary sm:block ${isActive ? "text-foreground" : "text-muted-foreground"}`
              }
            >
              What we built
            </NavLink>
            <ThemeToggle />
            <WalletButton />
          </nav>
        </div>
        {error && (
          <p className="mx-auto max-w-6xl px-4 pb-2 text-[0.8125rem] text-destructive sm:px-6" role="alert">
            {error}
          </p>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-[0.875rem] text-muted-foreground sm:px-6">
          <span className="flex items-center gap-2">
            <AlloyMark className="h-4 w-auto" />
            Alloy on Stellar, built at HackMeridian 2026
          </span>
          <Link to="/built" className="hover:text-foreground">What we built</Link>
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
