import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SearchService, paginate } from "@/server/search/service";
import { UpstreamFailure } from "@/server/deepseek/search";
import { emptyFilters } from "@/shared/search";
import type { Snapshot } from "@/server/search/storage";
import { MemoryContent, MemoryControl, evidence } from "../fixtures/search";

const snapshot = (count: number): Snapshot => ({ id: randomUUID(), query: "test", effectiveQuery: "test", filters: emptyFilters(), results: evidence(count), fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), cache: "miss", warnings: [] });
describe("snapshot pagination", () => {
  it.each([0, 1, 10, 11, 37, 50])("paginates %i results in stable slices of ten", count => {
    const data = snapshot(count); const total = Math.ceil(count / 10);
    for (let page = 1; page <= Math.max(total, 1); page++) {
      const result = paginate(data, page, "request");
      expect(result.totalPages).toBe(total); expect(result.results).toHaveLength(Math.min(10, Math.max(0, count - (page - 1) * 10)));
      expect(result.hasPreviousPage).toBe(page > 1); expect(result.hasNextPage).toBe(page < total);
      for (const item of result.results) expect(item).not.toHaveProperty("summary");
    }
  });
  it.each([0, -1, 1.5, 5, NaN, Infinity])("rejects invalid page %s", page => expect(() => paginate(snapshot(37), page, "r")).toThrow(expect.objectContaining({ code: "INVALID_PAGE" })));
});
describe("search orchestration", () => {
  it("propagates browser cancellation to the supplier and discards late results", async () => {
    const store = new MemoryContent(); const control = new MemoryControl(); const controller = new AbortController();
    let entered!: () => void; let release!: () => void; let supplierSignal!: AbortSignal;
    const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const provider = vi.fn(async (_query: string, signal: AbortSignal) => { supplierSignal = signal; entered(); await held; return { results: evidence(), billed: true }; });
    const work = new SearchService(store, control, provider).search({ query: "Rust" }, "s", "ip", "r", controller.signal);
    try { await started; controller.abort(); expect(supplierSignal.aborted).toBe(true); }
    finally { release(); await work.catch(() => {}); }
    await expect(work).rejects.toMatchObject({ code: "REQUEST_CANCELLED" }); expect(store.snapshots.size).toBe(0); expect(provider).toHaveBeenCalledTimes(1);
  });
  it("does not reserve or invoke the supplier for an already cancelled request", async () => {
    const store = new MemoryContent(); const control = new MemoryControl(); const provider = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(new SearchService(store, control, provider).search({ query: "Rust" }, "s", "ip", "r", controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(provider).not.toHaveBeenCalled(); expect(control.reserved).toBe(0); expect(store.locks.size).toBe(0);
  });
  it("cancels a duplicate waiting for the lease without cancelling the owner", async () => {
    const store = new MemoryContent(); const control = new MemoryControl(); let release!: () => void; let entered!: () => void; let queued!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; }); const waiting = new Promise<void>(resolve => { queued = resolve; });
    let ownerSignal!: AbortSignal;
    const provider = vi.fn(async (_query: string, signal: AbortSignal) => { ownerSignal = signal; entered(); await held; return { results: evidence(), billed: true }; });
    const service = new SearchService(store, control, provider); const owner = service.search({ query: "Rust" }, "s", "ip", "owner"); await started;
    const lock = store.lock.bind(store); vi.spyOn(store, "lock").mockImplementation(async (...args) => { const acquired = await lock(...args); if (!acquired) queued(); return acquired; });
    const controller = new AbortController(); const duplicate = service.search({ query: "Rust" }, "s", "ip", "duplicate", controller.signal);
    try {
      await waiting; controller.abort(); await expect(duplicate).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
      expect(ownerSignal.aborted).toBe(false); expect(store.locks.size).toBe(1); expect(control.reserved).toBe(1);
    } finally { release(); await owner; }
    expect(store.locks.size).toBe(0); expect(provider).toHaveBeenCalledTimes(1);
  });
  it("coalesces duplicate requests; cached searches and page reads do not call upstream", async () => {
    const store = new MemoryContent(); const control = new MemoryControl();
    const provider = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { results: evidence(), billed: true }; });
    const service = new SearchService(store, control, provider);
    const [first, duplicate] = await Promise.all([service.search({ query: "Rust" }, "s", "ip", "a"), service.search({ query: "Rust" }, "s", "ip", "b")]);
    expect(provider).toHaveBeenCalledTimes(1); expect(duplicate.cache).toBe("hit"); expect(duplicate.fetchedAt).toBe(first.fetchedAt);
    const page = await service.page("s", first.searchId, 4, "c"); expect(page.results).toHaveLength(7); expect(page.results[0].sourceId).toBe("S31");
    expect(provider).toHaveBeenCalledTimes(1); expect(control.reserved).toBe(1);
  });
  it("isolates sessions and refuses expired or foreign snapshots", async () => {
    const store = new MemoryContent(); const service = new SearchService(store, new MemoryControl(), vi.fn(async () => ({ results: evidence(), billed: true })));
    const first = await service.search({ query: "Rust" }, "s", "ip", "r");
    await expect(service.page("other", first.searchId, 1, "r")).rejects.toMatchObject({ status: 410 });
    for (const data of store.snapshots.values()) data.expiresAt = "2000-01-01T00:00:00Z";
    await expect(service.page("s", first.searchId, 1, "r")).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
  });
  it("invalidates late writes after clearing without resetting usage", async () => {
    const store = new MemoryContent(); const control = new MemoryControl(); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const pending = new Promise<void>(resolve => { release = resolve; });
    const service = new SearchService(store, control, async () => { entered(); await pending; return { results: evidence(), billed: true }; });
    const search = service.search({ query: "Rust" }, "s", "ip", "r"); await started; await service.clear("s"); release();
    await expect(search).rejects.toMatchObject({ code: "SESSION_CLEARED" }); expect(store.snapshots.size).toBe(0); expect(store.caches.size).toBe(0); expect(control.reserved).toBe(1);
  });
  it.each([401, 402])("opens circuit without retrying status %i", async status => {
    const control = new MemoryControl(); const provider = vi.fn(async () => { throw new UpstreamFailure(status, 0, false); });
    const service = new SearchService(new MemoryContent(), control, provider);
    await expect(service.search({ query: "Rust" }, "s", "ip", "r")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(provider).toHaveBeenCalledTimes(1); expect(control.tripped).toEqual([status]); expect(control.settled).toEqual(["reservation-1:free"]);
  });
  it("retries at most once and retains unknown charges", async () => {
    const control = new MemoryControl(); const provider = vi.fn(async () => { throw new UpstreamFailure(0, 0, true); });
    await expect(new SearchService(new MemoryContent(), control, provider).search({ query: "Rust" }, "s", "ip", "r")).rejects.toThrow();
    expect(provider).toHaveBeenCalledTimes(2); expect(control.reserved).toBe(2); expect(control.settled).toEqual(["reservation-1:uncertain", "reservation-2:uncertain"]);
  });
  it("does not call upstream when accounting storage fails", async () => {
    const control = new MemoryControl(); control.blocked = true; const provider = vi.fn();
    await expect(new SearchService(new MemoryContent(), control, provider).search({ query: "Rust" }, "s", "ip", "r")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" }); expect(provider).not.toHaveBeenCalled();
  });
  it("uses stale ordinary cache only after upstream failure and preserves fetchedAt", async () => {
    const store = new MemoryContent(); const provider = vi.fn().mockResolvedValueOnce({ results: evidence(), billed: true }).mockRejectedValue(new UpstreamFailure(500, 0, false));
    const service = new SearchService(store, new MemoryControl(), provider); const first = await service.search({ query: "Rust" }, "s", "ip", "r");
    for (const cached of store.caches.values()) cached.softExpiresAt = Date.now() - 1;
    const stale = await service.search({ query: "Rust" }, "s", "ip", "r"); expect(stale.cache).toBe("stale"); expect(stale.fetchedAt).toBe(first.fetchedAt); expect(stale.warnings).toHaveLength(1);
  });
  it("never falls back to stale results for time sensitive queries", async () => {
    const store = new MemoryContent(); const provider = vi.fn().mockResolvedValueOnce({ results: evidence(), billed: true }).mockRejectedValue(new UpstreamFailure(500, 0, false));
    const service = new SearchService(store, new MemoryControl(), provider); await service.search({ query: "今日新闻" }, "s", "ip", "r");
    for (const cached of store.caches.values()) cached.softExpiresAt = Date.now() - 1;
    await expect(service.search({ query: "今日新闻" }, "s", "ip", "r")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});
