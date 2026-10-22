import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalUrl, normalizeResults, requestSearch, UpstreamFailure } from "@/server/deepseek/search";

const row = (url = "https://example.com/a") => ({ title: "标题", url, snippet: "摘要", summary: "证据", date: null, site_name: null, rerank_score: 0, authority: -1 });
afterEach(() => vi.unstubAllGlobals());
describe("upstream contract", () => {
  it("normalizes known tracking parameters, retains unknown parameters and original links", () => {
    const original = "https://EXAMPLE.com:443/a?x=1&utm_source=search&y=2#part";
    expect(canonicalUrl(original)).toBe("https://example.com/a?x=1&y=2");
    const results = normalizeResults({ results: [row(original), row("https://example.com/a?x=1&y=2"), row("https://example.com/b")] });
    expect(results.map(r => r.sourceId)).toEqual(["S01", "S02"]); expect(results[0].url).toBe(original); expect(results[0].siteName).toBe("example.com");
  });
  it.each(["javascript:alert(1)", "data:text/html,x", "https://user:password@example.com", "http://localhost/a", "http://127.0.0.1", "http://[::1]/", "http://10.0.0.1", "http://192.168.1.1"])("drops unsafe link %s", url => expect(normalizeResults({ results: [row(url)] })).toEqual([]));
  it("handles missing date/content and unknown fields", () => {
    expect(normalizeResults({ results: [{ ...row(), date: undefined, site_icon: null, extra: "unknown" }] })[0]).toMatchObject({ publishedAt: null, summary: "证据" });
    expect(normalizeResults({ results: [] })).toEqual([]);
  });
  it("rejects structural drift instead of inventing results", () => {
    expect(() => normalizeResults({ data: [] })).toThrow(); expect(() => normalizeResults({ results: [{ url: "https://example.com" }] })).toThrow();
  });
  it("keeps the key server side and sends the documented fixed search contract", async () => {
    process.env.DEEPSEEK_API_KEY = "unit-test-key";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [row()] }), { status: 200 })); vi.stubGlobal("fetch", fetcher);
    const result = await requestSearch("Rust", new AbortController().signal);
    expect(result.billed).toBe(true); expect(fetcher.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/tools/search");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ query: "Rust", count: 50, need_content: false });
  });
  it("respects Retry-After and marks network failure as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "2" } })));
    await expect(requestSearch("Rust", new AbortController().signal)).rejects.toMatchObject({ status: 429, retryDelay: 2000, uncertain: false });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(requestSearch("Rust", new AbortController().signal)).rejects.toBeInstanceOf(UpstreamFailure);
    await expect(requestSearch("Rust", new AbortController().signal)).rejects.toMatchObject({ uncertain: true });
  });
});
