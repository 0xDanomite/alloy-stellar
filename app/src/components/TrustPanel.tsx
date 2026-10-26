import type { ReactNode } from "react";
import { deployments, expert, fundRelease, links } from "../lib/config";
import { shortId } from "../lib/format";
import type { Fund } from "../lib/stellar";
import { Lock, Shield } from "./icons";
import { CopyId } from "./ui";

function Fact({ term, children, note }: { term: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
      <dt className="text-[0.8125rem] text-muted-foreground">{term}</dt>
      <dd className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        {note && <p className="mt-1 text-[0.8125rem] text-muted-foreground">{note}</p>}
      </dd>
    </div>
  );
}

export function TrustPanel({ fund }: { fund: Fund }) {
  const release = fundRelease(fund.wasmHash);
  const platform = deployments?.contracts.platform;
  const nav = deployments?.contracts.nav;
  return (
    <div className="panel overflow-hidden rounded-2xl">
      <div className="flex items-start gap-3 border-b bg-surface-sunken/60 px-5 py-4">
        <Lock className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="font-medium">Redemption cannot be paused.</p>
          <p className="mt-0.5 max-w-[40rem] text-[0.8125rem] text-muted-foreground">
            The fund contract has no pause switch, no admin override and no upgrade path. Any holder can redeem shares for their slice of
            every asset at any time; an asset they can't receive yet is booked to them as owed instead of blocking the rest.
          </p>
        </div>
      </div>
      <dl className="divide-y">
        <Fact
          term="Fund code"
          note={
            release
              ? "Built in GitHub Actions from tagged source and attested (SEP-55); the hash below is what this contract runs."
              : "This code hash doesn't match an attested Alloy release."
          }
        >
          {release ? (
            <a href={release.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline">
              <Shield className="size-4" />
              Attested build {release.tag}
            </a>
          ) : (
            <span className="text-warning">Unverified build</span>
          )}
          {fund.wasmHash && (
            <span className="num rounded-sm border bg-surface-sunken px-2 py-0.5 text-[0.75rem]" title={fund.wasmHash}>
              {shortId(fund.wasmHash, 8, 8)}
            </span>
          )}
        </Fact>
        <Fact term="Fund contract">
          <CopyId id={fund.id} />
        </Fact>
        <Fact term="Manager" note="Can rebalance the basket within a 1% oracle bound and manage the allowlist. Cannot pause redemption or change the code.">
          <CopyId id={fund.manager} kind="account" />
        </Fact>
        {platform && (
          <Fact term="Platform" note="Created this fund and keeps the asset shelf a manager may pick from.">
            <CopyId id={platform} />
          </Fact>
        )}
        {nav && (
          <Fact term="NAV contract" note="Read-only: prices shares from oracles, holds nothing, and issue and redeem never consult it.">
            <CopyId id={nav} />
          </Fact>
        )}
        <Fact term="Source">
          <a href={links.repo} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
            {links.repo.replace(/^https:\/\//, "")}
          </a>
          <a href={expert.contract(fund.id)} target="_blank" rel="noreferrer" className="text-[0.8125rem] text-muted-foreground hover:text-foreground">
            Contract on Stellar Expert
          </a>
        </Fact>
      </dl>
    </div>
  );
}
