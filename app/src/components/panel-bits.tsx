import type { ReactNode } from "react";

export function SharesInput({
  id,
  label,
  value,
  onChange,
  invalid,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-label">
          {label}
        </label>
        {hint}
      </div>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(",", "."))}
        aria-invalid={invalid}
        className="num mt-2 w-full rounded-md border bg-surface-sunken px-3 py-2.5 text-figure outline-none focus:border-ring aria-[invalid=true]:border-destructive"
      />
      {invalid && <p className="mt-1 text-[0.8125rem] text-destructive">Enter a positive amount with up to 7 decimals.</p>}
    </div>
  );
}

export function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="flex items-center gap-2.5 text-label">
        <span
          className={`grid size-6 place-items-center rounded-full text-[0.75rem] ${done ? "bg-success text-primary-foreground" : "bg-secondary"}`}
          aria-hidden
        >
          {done ? <span className="check-draw">✓</span> : n}
        </span>
        Step {n}: {title}
        {done && <span className="sr-only">(done)</span>}
      </h3>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}
