import { describe, expect, it } from "vitest";
import { compileQuery } from "@/server/search/query";
import { emptyFilters } from "@/shared/search";

describe("query contract", () => {
  it("trims only boundaries and counts Unicode code points", () => {
    expect(compileQuery({ query: "  Rust  ASYNC \"A B\"  " }).effectiveQuery).toBe('Rust  ASYNC "A B"');
    expect(compileQuery({ query: "😀".repeat(128) }).query).toHaveLength(256);
    expect(() => compileQuery({ query: "😀".repeat(129) })).toThrow(expect.objectContaining({ code: "QUERY_TOO_LONG" }));
  });
  it.each(["", "   ", "\n\t"])("rejects blank %j", query => expect(() => compileQuery({ query })).toThrow(expect.objectContaining({ code: "INVALID_QUERY" })));
  it("compiles validated filters without rewriting the query", () => {
    expect(compileQuery({ query: "Rust", filters: { ...emptyFilters(), languages: ["en", "zh"], includeDomains: ["Rust-Lang.org", "docs.rs"], excludeDomains: ["example.com"], after: "2026-10-01", before: "2026-10-22" } }).effectiveQuery)
      .toBe("Rust site:rust-lang.org OR site:docs.rs -site:example.com lang:en,zh after:2026-10-01 before:2026-10-22");
  });
  it("rejects overlong compiled queries", () => expect(() => compileQuery({ query: "a".repeat(120), filters: { languages: ["zh", "en"] } })).toThrow(expect.objectContaining({ code: "QUERY_TOO_LONG" })));
  it.each(["https://example.com", "example.com/path", "x.com site:evil.com", "user@example.com", "localhost"])("rejects injected/invalid domain %j", domain => expect(() => compileQuery({ query: "x", filters: { includeDomains: [domain] } })).toThrow(expect.objectContaining({ code: "INVALID_FILTER" })));
  it.each(["lang:zh", "LANG:zh"])("rejects operator conflicts %s", operator => expect(() => compileQuery({ query: `x ${operator}`, filters: { languages: ["en"] } })).toThrow(expect.objectContaining({ code: "FILTER_CONFLICT" })));
  it("allows quoted operator text", () => expect(compileQuery({ query: '"lang:zh" syntax', filters: { languages: ["en"] } }).effectiveQuery).toBe('"lang:zh" syntax lang:en'));
  it("rejects date rollovers and reversed ranges", () => {
    expect(() => compileQuery({ query: "x", filters: { after: "2026-02-30" } })).toThrow();
    expect(() => compileQuery({ query: "x", filters: { after: "2026-10-22", before: "2026-10-21" } })).toThrow();
  });
  it("rejects contradictory domain filters", () => expect(() => compileQuery({ query: "x", filters: { includeDomains: ["a.com"], excludeDomains: ["a.com"] } })).toThrow(expect.objectContaining({ code: "FILTER_CONFLICT" })));
});
