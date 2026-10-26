import { useState } from "react";
import { expert } from "../lib/config";
import type { SetupStep } from "../lib/manager";
import { explain } from "../lib/stellar";
import { useWallet } from "../lib/wallet";
import { Button, Spinner } from "./ui";

type StepState = { state: "waiting" } | { state: "signing" } | { state: "done"; hash?: string } | { state: "failed"; message: string };

/**
 * Runs a fund's remaining setup calls one transaction at a time, each its
 * own wallet signature, and shows where each one stands. Steps already on
 * the ledger start out done, so a closed tab resumes where it stopped.
 */
export function SetupChecklist({
  steps,
  onFinished,
  actionLabel = "Sign the remaining steps",
}: {
  steps: SetupStep[];
  onFinished: () => void;
  actionLabel?: string;
}) {
  const { address } = useWallet();
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);
  const stateOf = (step: SetupStep): StepState => states[step.id] ?? (step.done ? { state: "done" } : { state: "waiting" });
  const remaining = steps.filter((s) => stateOf(s).state !== "done");

  async function runAll() {
    if (!address) return;
    setRunning(true);
    for (const step of remaining) {
      setStates((s) => ({ ...s, [step.id]: { state: "signing" } }));
      try {
        const result = await step.run(address);
        setStates((s) => ({ ...s, [step.id]: { state: "done", hash: result.hash } }));
      } catch (err) {
        setStates((s) => ({ ...s, [step.id]: { state: "failed", message: explain(err) } }));
        setRunning(false);
        return;
      }
    }
    setRunning(false);
    onFinished();
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {steps.map((step, i) => {
          const s = stateOf(step);
          return (
            <li key={step.id} className="flex items-start gap-3 text-[0.9375rem]">
              <span
                className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[0.75rem] ${s.state === "done" ? "bg-success text-primary-foreground" : s.state === "failed" ? "bg-destructive text-primary-foreground" : "bg-secondary"}`}
                aria-hidden
              >
                {s.state === "done" ? <span className="check-draw">✓</span> : s.state === "signing" ? <Spinner /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className={s.state === "done" ? "text-muted-foreground" : ""}>{step.label}</span>
                  {s.state === "done" && s.hash && (
                    <a href={expert.tx(s.hash)} target="_blank" rel="noreferrer" className="text-[0.8125rem] text-primary underline-offset-4 hover:underline">
                      View
                    </a>
                  )}
                  {s.state === "signing" && <span className="text-[0.8125rem] text-muted-foreground">confirm in your wallet</span>}
                </div>
                {s.state === "failed" && <p className="text-[0.8125rem] text-destructive">{s.message}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {remaining.length > 0 && (
        <Button className="w-full" onClick={runAll} busy={running} disabled={!address}>
          {actionLabel}
          {!running && remaining.length > 1 && <span className="num opacity-80">({remaining.length})</span>}
        </Button>
      )}
    </div>
  );
}
