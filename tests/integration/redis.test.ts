import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readyRedis, getRedis } from "@/server/infra/redis";
import { RedisCostControl, budgetDay } from "@/server/infra/control";
import { RedisContentStore, type Snapshot } from "@/server/search/storage";
import { SearchService } from "@/server/search/service";
import { emptyFilters } from "@/shared/search";
import { evidence } from "../fixtures/search";
import { POST } from "@/app/api/search/route";
import { GET } from "@/app/api/search/[searchId]/route";
import { DELETE } from "@/app/api/session/data/route";
import { saveCredential, resolveCredential, credentialStatus, rejectCredential } from "@/server/infra/credentials";

describe.skipIf(process.env.RUN_REDIS_TESTS !== "1")("real Redis atomic operations (isolated test ports)", () => {
  const store = new RedisContentStore(); const control = new RedisCostControl();
  beforeEach(async () => {
    // Test configuration is fixed to authenticated, dedicated instances. Never use deployment URLs here.
    const { content, control: redis, controlRunId } = await readyRedis();
    if (content.options.port !== 16379 || redis.options.port !== 16380 || redis.options.password !== "deepsearch-test") throw new Error("Dedicated test Redis required");
    await content.flushdb(); await redis.flushdb(); await redis.set("ds:control:approved_run_id", controlRunId);
  });
  afterAll(() => { const redis = getRedis(); redis.content.disconnect(); redis.control.disconnect(); });
  it("makes atomic budget reservations under contention across instances", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => new RedisCostControl().reserve()));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(10);
    const { control: redis } = await readyRedis(); expect(await redis.hget(`ds:usage:${budgetDay()}`, "used")).toBe("10000");
  });
  it("closes the paid gate after a control restart identity mismatch", async () => {
    const { control: redis } = await readyRedis(); await redis.set("ds:control:approved_run_id", "old-process");
    await expect(control.reserve()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("settles idempotently and retains uncertain usage", async () => {
    const a = await control.reserve(); await control.settle(a, "free"); await control.settle(a, "free");
    const b = await control.reserve(); await control.settle(b, "uncertain");
    const c = await control.reserve(); await control.settle(c, "billed");
    await expect(control.reserve()).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const { control: redis } = await readyRedis(); expect(await redis.hgetall(`ds:usage:${budgetDay()}`)).toMatchObject({ used: "10000", reserved: "0", uncertain: "5000", confirmed: "5000" });
  });
  it("does not release another request's lease", async () => {
    await store.version("s"); expect(await store.lock("s", "1", "key", "owner")).toBe(true);
    await store.unlock("s", "1", "key", "intruder"); expect(await store.lock("s", "1", "key", "second")).toBe(false);
    await store.unlock("s", "1", "key", "owner"); expect(await store.lock("s", "1", "key", "second")).toBe(true);
  });
  it("atomically invalidates both existing content and future late writes", async () => {
    const version = await store.version("s"); const row: Snapshot = { id: randomUUID(), query: "secret-query", effectiveQuery: "secret-query", filters: emptyFilters(), results: evidence(), fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), cache: "miss", warnings: [] };
    const cache = { results: evidence(), fetchedAt: row.fetchedAt, softExpiresAt: Date.now() + 5000, hardExpiresAt: Date.now() + 10000 };
    await store.commit("s", version, "hmac-key", row, cache); expect(await store.snapshot("s", row.id)).not.toBeNull();
    expect(await store.snapshot("stranger", row.id)).toBeNull(); await store.clear("s");
    expect(await store.snapshot("s", row.id)).toBeNull(); expect(await store.cache("s", version, "hmac-key")).toBeNull();
    await expect(store.commit("s", version, "hmac-key", row, cache)).rejects.toMatchObject({ code: "SESSION_CLEARED" });
  });
  it("coalesces across independent service objects using the distributed lease", async () => {
    const provider = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 50)); return { results: evidence(), billed: true }; });
    const first = new SearchService(new RedisContentStore(), new RedisCostControl(), provider); const second = new SearchService(new RedisContentStore(), new RedisCostControl(), provider);
    const result = await Promise.all([first.search({ query: "Rust" }, "s", "ip", "a"), second.search({ query: "Rust" }, "s", "ip", "b")]);
    expect(provider).toHaveBeenCalledTimes(1); expect(result.map(r => r.cache).sort()).toEqual(["hit", "miss"]);
    const { content, control: redis } = await readyRedis();
    expect((await content.keys("ds:*" )).some(key => key.includes("Rust"))).toBe(false);
    expect(JSON.stringify(await redis.hgetall(`ds:usage:${budgetDay()}`))).not.toContain("Rust");
  });
  it("content clear leaves the abuse quota and paid budget untouched", async () => {
    await store.version("s"); await control.rate("s", "ip"); await control.reserve(); await store.clear("s");
    const { control: redis } = await readyRedis(); expect(await redis.hget(`ds:usage:${budgetDay()}`, "reserved")).toBe("5000");
    expect(await redis.get(`ds:rate:session:s:${Math.floor(Date.now() / 60000)}`)).toBe("1");
  });
  it("runs the real HTTP handlers and adapter end to end with a stubbed supplier", async () => {
    const rows = evidence().map(row => ({ title: row.title, url: row.url, snippet: row.snippet, summary: row.summary, date: null, site_name: null, rerank_score: 1, authority: -1 }));
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: rows })));
    try {
      const created = await POST(new Request("http://localhost:3000/api/search", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ query: "Rust" }) }));
      expect(created.status).toBe(200); const first = await created.json(); expect(first.results).toHaveLength(10); expect(first.results[0]).not.toHaveProperty("summary");
      const cookie = created.headers.get("set-cookie")!.split(";")[0];
      const read = await GET(new Request(`http://localhost:3000/api/search/${first.searchId}?page=4`, { headers: { Cookie: cookie } }), { params: Promise.resolve({ searchId: first.searchId }) });
      expect((await read.json()).results).toHaveLength(7); expect(provider).toHaveBeenCalledTimes(1);
      const stranger = await GET(new Request(`http://localhost:3000/api/search/${first.searchId}?page=1`), { params: Promise.resolve({ searchId: first.searchId }) }); expect(stranger.status).toBe(410);
      const forbidden = await POST(new Request("http://localhost:3000/api/search", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ query: "Rust" }) })); expect(forbidden.status).toBe(403);
      expect(provider).toHaveBeenCalledTimes(1);
      expect((await DELETE(new Request("http://localhost:3000/api/session/data", { method: "DELETE", headers: { Origin: "http://localhost:3000", Cookie: cookie } }))).status).toBe(200);
      const gone = await GET(new Request(`http://localhost:3000/api/search/${first.searchId}`, { headers: { Cookie: cookie } }), { params: Promise.resolve({ searchId: first.searchId }) }); expect(gone.status).toBe(410);
    } finally { provider.mockRestore(); }
  });
  it("uses personal credentials only in their own session and never returns the key", async () => {
    const key = "personal-test-key-not-real"; const saved = await saveCredential("s", { apiKey: key });
    expect(saved).toMatchObject({ configured: true, source: "personal" }); expect(JSON.stringify(await credentialStatus("s"))).not.toContain(key);
    expect((await resolveCredential("s")).key).toBe(key); expect((await resolveCredential("stranger")).source).toBe("server");
    const { content } = await readyRedis(); expect(await content.get("ds:content:s:credential")).not.toContain(key);
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    try {
      await new SearchService(store, control).search({ query: "Rust" }, "s", "ip", "r");
      expect((provider.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
    } finally { provider.mockRestore(); }
    const version = await store.version("s"); await store.clear("s"); expect((await resolveCredential("s")).source).toBe("server");
    await expect(saveCredential("s", { apiKey: key }, version)).rejects.toMatchObject({ code: "SESSION_CLEARED" });
  });
  it("does not let an invalid personal key disable other sessions or a newer key", async () => {
    await saveCredential("s", { apiKey: "invalid-personal-key" }); const first = await resolveCredential("s");
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    try { await expect(new SearchService(store, control).search({ query: "Rust" }, "s", "ip", "r")).rejects.toMatchObject({ code: "API_KEY_INVALID" }); }
    finally { provider.mockRestore(); }
    expect((await credentialStatus("s")).state).toBe("invalid");
    const { control: redis } = await readyRedis(); expect(await redis.exists("ds:control:circuit")).toBe(0);
    await saveCredential("s", { apiKey: "new-personal-key" }); await rejectCredential("s", first.scope, 401);
    expect((await credentialStatus("s")).state).toBe("saved");
    await redis.set("ds:control:circuit", "401");
    const other = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    try { expect((await new SearchService(store, control).search({ query: "Rust" }, "s", "ip", "r")).results).toHaveLength(0); }
    finally { other.mockRestore(); }
  });
});
