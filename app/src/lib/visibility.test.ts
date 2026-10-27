import { describe, expect, it } from "vitest";
import type { Fund } from "./stellar";
import { listedFunds, statusOf } from "./visibility";

const fund = (id: string, hidden: boolean) => ({ id, hidden }) as Fund;

describe("statusOf", () => {
  it("hides only on the exact value hidden", () => {
    expect(statusOf("hidden")).toBe("hidden");
    for (const value of ["active", "", "Hidden", " hidden", "paused", undefined, null, 1]) {
      expect(statusOf(value)).toBe("active");
    }
  });
});

describe("listedFunds", () => {
  const funds = [fund("A", false), fund("B", true), fund("C", false)];

  it("leaves hidden funds out by default, in order", () => {
    expect(listedFunds(funds).map((f) => f.id)).toEqual(["A", "C"]);
  });

  it("shows every fund when asked", () => {
    expect(listedFunds(funds, true).map((f) => f.id)).toEqual(["A", "B", "C"]);
  });
});
