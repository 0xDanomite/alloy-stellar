import { describe, expect, it } from "vitest";
import { parseWebsite } from "./website";

describe("parseWebsite", () => {
  it("keeps a plain https site and shows its host", () => {
    expect(parseWebsite("https://example.com/fund")).toEqual({ href: "https://example.com/fund", host: "example.com" });
  });

  it("refuses credentials that make another host look like the label", () => {
    expect(parseWebsite("https://alloy-stellar.vercel.app@evil.example/")).toBeNull();
    expect(parseWebsite("https://user:pass@example.com")).toBeNull();
  });

  it("refuses anything but https", () => {
    expect(parseWebsite("javascript:alert(1)")).toBeNull();
    expect(parseWebsite("http://example.com")).toBeNull();
    expect(parseWebsite("data:text/html,hi")).toBeNull();
  });

  it("shows an internationalized host in its punycode form", () => {
    expect(parseWebsite("https://аlloy.com")?.host).toBe("xn--lloy-43d.com");
  });

  it("refuses empty and unparseable input", () => {
    expect(parseWebsite(undefined)).toBeNull();
    expect(parseWebsite("  ")).toBeNull();
    expect(parseWebsite("not a url")).toBeNull();
    expect(parseWebsite("https://localhost")).toBeNull();
    expect(parseWebsite(`https://example.com/${"a".repeat(120)}`)).toBeNull();
  });
});
