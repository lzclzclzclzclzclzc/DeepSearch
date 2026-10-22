import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readyRedis, getRedis } from "@/server/infra/redis";
import { RedisCostControl, budgetDay, dailyUsage } from "@/server/infra/control";
import { RedisContentStore, type Snapshot } from "@/server/search/storage";
import { SearchService } from "@/server/search/service";
import { emptyFilters } from "@/shared/search";
import { evidence } from "../fixtures/search";
import { POST } from "@/app/api/search/route";
import { GET } from "@/app/api/search/[searchId]/route";
import { GET as usageToday } from "@/app/api/usage/today/route";
import { createSessionCookie, sessionCookieName } from "@/server/infra/session";
import { DELETE } from "@/app/api/session/data/route";
import { saveCredential, resolveCredential, credentialStatus, rejectCredential } from "@/server/infra/credentials";
import { POST as answerPost, GET as answerGet } from "@/app/api/search/[searchId]/answer/route";
import { digest } from "@/server/infra/config";
import { readSSE } from "@/shared/sse";
import { AnswerStore, acquireSummarySlot } from "@/server/answer/storage";
import { api } from "@/server/infra/http";

describe.skipIf(process.env.RUN_REDIS_TESTS !== "1")("real Redis atomic operations (isolated test ports)", () => {
  const store = new RedisContentStore(); const control = new RedisCostControl();
  beforeEach(async () => {
    // Test configuration is fixed to authenticated, dedicated instances. Never use deployment URLs here.
    const { content, control: redis } = await readyRedis();
    if (content.options.port !== 16379 || redis.options.port !== 16380 || redis.options.password !== "deepsearch-test") throw new Error("Dedicated test Redis required");
    await content.flushdb(); await redis.flushdb();
  });
  afterAll(() => { const redis = getRedis(); redis.content.disconnect(); redis.control.disconnect(); });
  async function seedAnswer() {
    const cookie = createSessionCookie(); const session = digest(cookie.id); const version = await store.version(session);
    const snapshot: Snapshot = { id: randomUUID(), query: "Rust", effectiveQuery: "Rust", filters: emptyFilters(), results: evidence(12).map(row => ({ ...row, summary: "这是用于核对的网页证据，介绍异步编程中的任务与运行时。".repeat(8) })), fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), cache: "miss", warnings: [] };
    await store.commit(session, version, "answer-fixture", snapshot);
    const headers = { Origin: "http://localhost:3333", Cookie: `${sessionCookieName}=${cookie.value}`, "Content-Type": "application/json" };
    const params = { params: Promise.resolve({ searchId: snapshot.id }) };
    const request = (body: unknown = { requestId: randomUUID() }, signal?: AbortSignal) => new Request(`http://localhost:3333/api/search/${snapshot.id}/answer`, { method: "POST", headers, body: JSON.stringify(body), signal });
    return { session, version, snapshot, headers, params, request };
  }
  const modelResponse = (text = "这是有证据支持的总结[S01]。\n\n另一段结论[S02]。") => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } })}\n\ndata: [DONE]\n\n`);
  async function answerEvents(response: Response) { const events = []; for await (const event of readSSE(response.body!)) events.push({ event: event.event, data: JSON.parse(event.data) }); return events; }
  it("streams cited answers, rejects foreign evidence and reuses the same answer without billing again", async () => {
    const fixture = await seedAnswer();
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => modelResponse("合法结论[S01]。\n\n幻觉来源[S99]。\n\n没有引用的内容"));
    try {
      const requestId = randomUUID(); const first = await answerPost(fixture.request({ requestId }), fixture.params);
      expect(first.headers.get("content-type")).toContain("text/event-stream"); const events = await answerEvents(first);
      const blocks = events.filter(row => row.event === "answer.block").map(row => row.data);
      expect(blocks).toHaveLength(2); expect(blocks[0].citations).toEqual(["S01"]); expect(blocks[1].notice).toBe(true);
      expect(JSON.stringify(blocks)).not.toContain("幻觉来源"); expect(events.at(-1)?.event).toBe("done");
      const second = await answerEvents(await answerPost(fixture.request({ requestId }), fixture.params)); expect(second[0].data.phase).toBe("cached"); expect(provider).toHaveBeenCalledTimes(1);
      const read = await answerGet(new Request(fixture.request().url, { headers: fixture.headers }), fixture.params); expect((await read.json()).answer.blocks).toEqual(blocks);
      expect((await answerGet(new Request(fixture.request().url), fixture.params)).status).toBe(410);
      expect((await answerPost(new Request(fixture.request().url, { method: "POST", headers: { ...fixture.headers, Origin: "https://evil.example" }, body: JSON.stringify({ requestId }) }), fixture.params)).status).toBe(403);
      expect((await answerPost(fixture.request({ requestId, evidence: "invented" }), fixture.params)).status).toBe(400);
      expect(await dailyUsage()).toMatchObject({ confirmedCny: 0.00036, paidSearches: 0, summaries: 1, pendingCny: 0 });
    } finally { provider.mockRestore(); }
  });
  it("rejects stale snapshots and avoids the model entirely when no evidence exists", async () => {
    const fixture = await seedAnswer(); const provider = vi.spyOn(globalThis, "fetch");
    try {
      fixture.snapshot.fetchedAt = "2000-01-01T00:00:00Z"; await store.commit(fixture.session, fixture.version, "x", fixture.snapshot);
      expect((await answerPost(fixture.request(), fixture.params)).status).toBe(410);
      fixture.snapshot.fetchedAt = new Date().toISOString(); fixture.snapshot.results = []; await store.commit(fixture.session, fixture.version, "x", fixture.snapshot);
      const events = await answerEvents(await answerPost(fixture.request(), fixture.params)); expect(events.find(row => row.event === "answer.block")?.data.notice).toBe(true);
      expect(provider).not.toHaveBeenCalled(); expect((await dailyUsage()).attempts).toBe(0);
    } finally { provider.mockRestore(); }
  });
  it("supplements at most three existing sources with at most two concurrent fetches", async () => {
    const fixture = await seedAnswer(); fixture.snapshot.results = fixture.snapshot.results.map((row, i) => ({ ...row, domain: `site${i}.example.com`, url: `https://site${i}.example.com/article`, summary: "" }));
    await store.commit(fixture.session, fixture.version, "x", fixture.snapshot); let active = 0; let maxActive = 0;
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/tools/fetch")) { active++; maxActive = Math.max(active, maxActive); await new Promise(resolve => setTimeout(resolve, 20)); active--; return Response.json({ title: "原网页", content: "已获取的真实证据材料。".repeat(40) }); }
      return modelResponse();
    });
    try {
      const events = await answerEvents(await answerPost(fixture.request(), fixture.params)); expect(events.at(-1)?.event).toBe("done");
      expect(provider.mock.calls.filter(call => String(call[0]).endsWith("/tools/fetch"))).toHaveLength(3); expect(maxActive).toBeLessThanOrEqual(2);
      expect((await dailyUsage()).fetches).toBe(3); expect((await dailyUsage()).summaries).toBe(1);
      for (const call of provider.mock.calls.filter(call => String(call[0]).endsWith("/tools/fetch"))) expect(fixture.snapshot.results.map(row => row.url)).toContain(JSON.parse(String(call[1]?.body)).url);
    } finally { provider.mockRestore(); }
  });
  it("coalesces active requests and propagates cancellation without saving partial answers", async () => {
    const fixture = await seedAnswer(); const controller = new AbortController(); const requestId = randomUUID(); let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; }); let supplierAborted = false;
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(output) {
      output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "正在生成[S01]。\n\n" } }] })}\n\n`));
      init?.signal?.addEventListener("abort", () => { supplierAborted = true; output.error(new DOMException("Aborted", "AbortError")); }); began();
    } })));
    try {
      const first = await answerPost(fixture.request({ requestId }, controller.signal), fixture.params); await started;
      expect((await answerPost(fixture.request(), fixture.params)).status).toBe(409);
      controller.abort(); const events = await answerEvents(first); expect(events.at(-1)?.event).toBe("error"); expect(supplierAborted).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1); const { control: redis } = await readyRedis(); expect(await redis.zcard("ds:summary:active")).toBe(0);
      const read = await answerGet(new Request(fixture.request().url, { headers: fixture.headers }), fixture.params); expect((await read.json()).answer).toBeNull();
      expect((await dailyUsage()).uncertainCny).toBe(0.032);
      expect((await answerPost(fixture.request({ requestId }), fixture.params)).status).toBe(409); expect(provider).toHaveBeenCalledTimes(1);
    } finally { provider.mockRestore(); }
  });
  it("prevents late summary writes after session clear", async () => {
    const fixture = await seedAnswer(); const answers = new AnswerStore(fixture.session, fixture.version, fixture.snapshot.id, fixture.snapshot.expiresAt);
    await store.clear(fixture.session);
    await expect(answers.write("answer:test", { text: "late" })).rejects.toMatchObject({ code: "SESSION_CLEARED" });
  });
  it("bounds the shared summary queue and releases acquired leases", async () => {
    const { control: redis } = await readyRedis();
    const release = await acquireSummarySlot(new AbortController().signal); expect(await redis.zcard("ds:summary:active")).toBe(1); await release();
    for (let i = 0; i < 20; i++) await redis.zadd("ds:summary:active", Date.now() + 5000, `active-${i}`);
    for (let i = 0; i < 10; i++) await redis.zadd("ds:summary:queue", Date.now() + 5000, `waiting-${i}`);
    await expect(acquireSummarySlot(new AbortController().signal)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(await redis.zcard("ds:summary:active")).toBe(20); expect(await redis.zcard("ds:summary:queue")).toBe(10);
  });
  it("invalid model credentials are free and do not invalidate another session", async () => {
    const fixture = await seedAnswer(); await saveCredential(fixture.session, { apiKey: "invalid-summary-personal-key" });
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    try {
      const events = await answerEvents(await answerPost(fixture.request(), fixture.params)); expect(events.at(-1)?.data.code).toBe("API_KEY_INVALID");
      expect((await credentialStatus(fixture.session)).state).toBe("invalid"); expect((await credentialStatus("other")).source).toBe("server");
      expect((await dailyUsage()).totalCny).toBe(0);
    } finally { provider.mockRestore(); }
  });
  it("tracks concurrent calls without a daily spending cap", async () => {
    const { control: redis } = await readyRedis(); await redis.hset(`ds:usage:${budgetDay()}`, "used", "10000000", "confirmed", "10000000");
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => new RedisCostControl().reserve()));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(12);
    expect(await redis.hget(`ds:usage:${budgetDay()}`, "used")).toBe("10060000");
    expect(await dailyUsage()).toMatchObject({ totalCny: 10.06, confirmedCny: 10, pendingCny: 0.06, attempts: 12 });
  });
  it("does not pool visitors into one IP quota when no client IP is trusted", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
    const visitors = Array.from({ length: 4 }, () => createSessionCookie());
    const call = (visitor: typeof visitors[number]) => api(new Request("http://localhost:3333/api/test-rate", { headers: { Cookie: `${sessionCookieName}=${visitor.value}`, "X-Real-IP": "203.0.113.1" } }), async ctx => { await control.rate(ctx.session, ctx.ip); return { ok: true }; }, { event: "test_rate" });
    for (let index = 0; index < 64; index++) expect((await call(visitors[index % 4])).status).toBe(200);
    for (let index = 0; index < 4; index++) expect((await call(visitors[0])).status).toBe(200);
    expect((await call(visitors[0])).status).toBe(429);
    const { control: redis } = await readyRedis(); expect(await redis.keys("ds:rate:ip:*")).toHaveLength(0);
    } finally { log.mockRestore(); }
  });
  it("still enforces a known client network quota across different sessions", async () => {
    for (let index = 0; index < 60; index++) await control.rate(`visitor-${index % 4}`, "trusted-network");
    await expect(control.rate("another-visitor", "trusted-network")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("propagates HTTP search aborts through the adapter without retry or late writes", async () => {
    const controller = new AbortController(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let supplierAborted = false;
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { supplierAborted = true; reject(new DOMException("Aborted", "AbortError")); }); entered();
    }));
    try {
      const pending = POST(new Request("http://localhost:3333/api/search", { method: "POST", signal: controller.signal, headers: { Origin: "http://localhost:3333", "Content-Type": "application/json" }, body: JSON.stringify({ query: "Rust" }) }));
      await started; controller.abort(); const response = await pending;
      expect(response.status).toBe(499); expect((await response.json()).error.code).toBe("REQUEST_CANCELLED");
      expect(supplierAborted).toBe(true); expect(provider).toHaveBeenCalledTimes(1);
      expect(await dailyUsage()).toMatchObject({ attempts: 1, uncertainCny: 0.005, pendingCny: 0 });
      const { content } = await readyRedis(); expect(await content.keys("*:snapshot:*")).toHaveLength(0); expect(await content.keys("*:lock:*")).toHaveLength(0);
    } finally { controller.abort(); provider.mockRestore(); }
  });
  it("starts accounting without an approval gate or a matching legacy run ID", async () => {
    const { control: redis } = await readyRedis(); await redis.set("ds:control:approved_run_id", "old-process");
    await expect(control.reserve()).resolves.toEqual(expect.any(String));
  });
  it("settles idempotently and retains uncertain usage", async () => {
    const a = await control.reserve(); await control.settle(a, "free"); await control.settle(a, "free");
    const b = await control.reserve(); await control.settle(b, "uncertain");
    const c = await control.reserve(); await control.settle(c, "billed");
    const { control: redis } = await readyRedis(); expect(await redis.hgetall(`ds:usage:${budgetDay()}`)).toMatchObject({ used: "10000", reserved: "0", uncertain: "5000", confirmed: "5000" });
    expect(await dailyUsage()).toMatchObject({ totalCny: 0.01, confirmedCny: 0.005, uncertainCny: 0.005, pendingCny: 0, attempts: 3, paidSearches: 1 });
  });
  it("returns today's usage read-only and requires a valid session", async () => {
    const { control: redis } = await readyRedis();
    await redis.hset("ds:usage:2000-01-01", "used", "999999");
    const id = await control.reserve(); await control.settle(id, "billed");
    const before = await redis.hgetall(`ds:usage:${budgetDay()}`);
    const session = createSessionCookie();
    const read = () => usageToday(new Request("http://localhost:3333/api/usage/today", { headers: { Cookie: `${sessionCookieName}=${session.value}` } }));
    for (let i = 0; i < 2; i++) {
      const response = await read(); expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ day: budgetDay(), timeZone: "Asia/Shanghai", totalCny: 0.005, attempts: 1, paidSearches: 1 });
    }
    expect(await redis.hgetall(`ds:usage:${budgetDay()}`)).toEqual(before);
    expect((await usageToday(new Request("http://localhost:3333/api/usage/today"))).status).toBe(410);
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
  it("content clear leaves the abuse quota and cost accounting untouched", async () => {
    await store.version("s"); await control.rate("s", "ip"); await control.reserve(); await store.clear("s");
    const { control: redis } = await readyRedis(); expect(await redis.hget(`ds:usage:${budgetDay()}`, "reserved")).toBe("5000");
    expect(await redis.get(`ds:rate:session:s:${Math.floor(Date.now() / 60000)}`)).toBe("1");
  });
  it("runs the real HTTP handlers and adapter end to end with a stubbed supplier", async () => {
    const rows = evidence().map(row => ({ title: row.title, url: row.url, snippet: row.snippet, summary: row.summary, date: null, site_name: null, rerank_score: 1, authority: -1 }));
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: rows })));
    try {
      const created = await POST(new Request("http://localhost:3333/api/search", { method: "POST", headers: { Origin: "http://localhost:3333", "Content-Type": "application/json" }, body: JSON.stringify({ query: "Rust" }) }));
      expect(created.status).toBe(200); const first = await created.json(); expect(first.results).toHaveLength(10); expect(first.results[0]).not.toHaveProperty("summary");
      const cookie = created.headers.get("set-cookie")!.split(";")[0];
      const read = await GET(new Request(`http://localhost:3333/api/search/${first.searchId}?page=4`, { headers: { Cookie: cookie } }), { params: Promise.resolve({ searchId: first.searchId }) });
      expect((await read.json()).results).toHaveLength(7); expect(provider).toHaveBeenCalledTimes(1);
      const stranger = await GET(new Request(`http://localhost:3333/api/search/${first.searchId}?page=1`), { params: Promise.resolve({ searchId: first.searchId }) }); expect(stranger.status).toBe(410);
      const forbidden = await POST(new Request("http://localhost:3333/api/search", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ query: "Rust" }) })); expect(forbidden.status).toBe(403);
      expect(provider).toHaveBeenCalledTimes(1);
      expect((await DELETE(new Request("http://localhost:3333/api/session/data", { method: "DELETE", headers: { Origin: "http://localhost:3333", Cookie: cookie } }))).status).toBe(200);
      const gone = await GET(new Request(`http://localhost:3333/api/search/${first.searchId}`, { headers: { Cookie: cookie } }), { params: Promise.resolve({ searchId: first.searchId }) }); expect(gone.status).toBe(410);
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
    const { control: redis } = await readyRedis(); expect(await redis.keys("ds:control:circuit:*")).toHaveLength(0);
    await saveCredential("s", { apiKey: "new-personal-key" }); await rejectCredential("s", first.scope, 401);
    expect((await credentialStatus("s")).state).toBe("saved");
    await control.trip(401, (await resolveCredential("stranger")).scope);
    const other = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    try { expect((await new SearchService(store, control).search({ query: "Rust" }, "s", "ip", "r")).results).toHaveLength(0); }
    finally { other.mockRestore(); }
  });
});
