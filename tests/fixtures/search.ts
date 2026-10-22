import { SearchError } from "@/shared/search";
import type { Evidence } from "@/server/deepseek/search";
import type { CostControl } from "@/server/infra/control";
import type { CacheEntry, ContentStore, Snapshot } from "@/server/search/storage";

export const evidence = (count = 37): Evidence[] => Array.from({ length: count }, (_, i) => ({ sourceId: `S${String(i + 1).padStart(2, "0")}`, title: `搜索结果 ${i + 1}`, url: `https://example.com/article/${i + 1}`, domain: "example.com", siteName: "示例网站", snippet: `第 ${i + 1} 条网页摘要。`, summary: "private evidence", publishedAt: null }));
export class MemoryContent implements ContentStore {
  versions = new Map<string, string>(); caches = new Map<string, CacheEntry>(); snapshots = new Map<string, Snapshot>(); locks = new Map<string, string>();
  async version(s: string) { if (!this.versions.has(s)) this.versions.set(s, "1"); return this.versions.get(s)!; }
  async cache(s: string, v: string, k: string) { return this.caches.get(`${s}:${v}:${k}`) ?? null; }
  async snapshot(s: string, id: string) { return this.snapshots.get(`${s}:${await this.version(s)}:${id}`) ?? null; }
  async lock(s: string, v: string, k: string, token: string) { const key = `${s}:${v}:${k}`; if (this.locks.has(key)) return false; this.locks.set(key, token); return true; }
  async unlock(s: string, v: string, k: string, token: string) { const key = `${s}:${v}:${k}`; if (this.locks.get(key) === token) this.locks.delete(key); }
  async commit(s: string, v: string, k: string, snapshot: Snapshot, cache?: CacheEntry) {
    if (this.versions.get(s) !== v) throw new SearchError("SESSION_CLEARED", "cleared", 409);
    this.snapshots.set(`${s}:${v}:${snapshot.id}`, snapshot); if (cache) this.caches.set(`${s}:${v}:${k}`, cache);
  }
  async clear(s: string) { this.versions.set(s, String(Number(await this.version(s)) + 1)); for (const k of this.snapshots.keys()) if (k.startsWith(s + ":")) this.snapshots.delete(k); for (const k of this.caches.keys()) if (k.startsWith(s + ":")) this.caches.delete(k); }
}
export class MemoryControl implements CostControl {
  reserved = 0; settled: string[] = []; tripped: number[] = []; blocked = false;
  async rate() {}
  async reserve() { if (this.blocked) throw new SearchError("BUDGET_EXCEEDED", "exhausted", 429); return `reservation-${++this.reserved}`; }
  async settle(id: string, state: string) { this.settled.push(`${id}:${state}`); }
  async trip(status: number) { this.tripped.push(status); }
}
