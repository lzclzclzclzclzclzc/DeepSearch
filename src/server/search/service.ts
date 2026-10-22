import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { SearchError, type SearchResponse } from "@/shared/search";
import { requestSearch, UpstreamFailure } from "@/server/deepseek/search";
import { digest, getConfig } from "@/server/infra/config";
import { RedisCostControl, type CostControl } from "@/server/infra/control";
import { recordRequest } from "@/server/infra/metrics";
import { resolveCredential, rejectCredential, type Credential } from "@/server/infra/credentials";
import { RedisContentStore, newSnapshotId, type ContentStore, type Snapshot, type CacheEntry } from "./storage";
import { compileQuery } from "./query";

export function paginate(snapshot: Snapshot, page: number, requestId: string): SearchResponse {
  const totalPages = Math.ceil(snapshot.results.length / 10);
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(1, totalPages)) throw new SearchError("INVALID_PAGE", "该页码不存在，请选择有效页码。");
  return { requestId, searchId: snapshot.id, query: snapshot.query, effectiveQuery: snapshot.effectiveQuery,
    fetchedAt: snapshot.fetchedAt, expiresAt: snapshot.expiresAt, cache: snapshot.cache,
    results: snapshot.results.slice((page - 1) * 10, page * 10).map(({ summary: _summary, ...result }) => result),
    snapshotCount: snapshot.results.length, page, pageSize: 10, totalPages, hasPreviousPage: page > 1, hasNextPage: page < totalPages, warnings: snapshot.warnings };
}
const tasks = new Map<string, Set<AbortController>>();
export class SearchService {
  constructor(private content: ContentStore, private control: CostControl, private provider = requestSearch) {}
  async search(raw: unknown, session: string, ip: string | null, requestId: string, requestSignal?: AbortSignal): Promise<SearchResponse> {
    const input = compileQuery(raw); const config = getConfig(); const started = Date.now();
    const controller = new AbortController();
    const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
    const checkCancelled = () => {
      if (!signal.aborted) return;
      if (signal.reason instanceof SearchError) throw signal.reason;
      throw new SearchError("REQUEST_CANCELLED", "搜索已取消。", 499);
    };
    const active = tasks.get(session) ?? new Set<AbortController>(); active.add(controller); tasks.set(session, active);
    const deadline = setTimeout(() => controller.abort(new SearchError("UPSTREAM_UNAVAILABLE", "搜索超时，请稍后重试。", 504, true)), config.SEARCH_DEADLINE_MS);
    const token = randomUUID(); let owned = false; let version = ""; let key = "";
    try {
      checkCancelled();
      await this.control.rate(session, ip);
      version = await this.content.version(session);
      const credential: Credential = this.provider === requestSearch ? await resolveCredential(session) : { key: config.DEEPSEEK_API_KEY, source: "server", scope: "test", state: "saved" };
      key = digest(JSON.stringify(["deepseek-search-v1", input.effectiveQuery, 50, false, "no-localization", "upstream-v1", credential.scope]));
      let cached = await this.content.cache(session, version, key);
      const create = async (entry: CacheEntry, cache: Snapshot["cache"], saveCache = false) => {
        checkCancelled();
        const snapshot: Snapshot = { id: newSnapshotId(), query: input.query, effectiveQuery: input.effectiveQuery, filters: input.filters,
          results: entry.results, fetchedAt: entry.fetchedAt, expiresAt: new Date(Date.now() + config.SNAPSHOT_TTL_SECONDS * 1000).toISOString(), cache,
          warnings: cache === "stale" ? ["搜索服务暂时不可用，当前展示较早获取的结果。请留意获取时间。"] : [] };
        await this.content.commit(session, version, key, snapshot, saveCache ? entry : undefined);
        await recordRequest("cache", cache, 0).catch(() => {});
        return paginate(snapshot, 1, requestId);
      };
      if (cached && cached.softExpiresAt > Date.now()) return await create(cached, "hit");
      if (this.provider === requestSearch && !credential.key) throw new SearchError("API_KEY_INVALID", "请先在设置中配置 API key。", 400);
      if (credential.state === "invalid") throw new SearchError("API_KEY_INVALID", "API key 无效，请在设置中更新。", 401);
      if (credential.state === "balance") throw new SearchError("API_BALANCE_INSUFFICIENT", "此 API key 的账户余额不足，请充值后在设置中重新保存。", 402);
      // Another instance may own this request; wait at most the remaining chain budget.
      checkCancelled();
      while (!(owned = await this.content.lock(session, version, key, token))) {
        checkCancelled();
        if (Date.now() - started > config.SEARCH_DEADLINE_MS - 200) throw new SearchError("RATE_LIMITED", "相同搜索仍在处理中，请稍后重试。", 429, true, 1);
        await sleep(80, undefined, { signal });
        if (await this.content.version(session) !== version) throw new SearchError("SESSION_CLEARED", "本次会话数据已清除，请重新搜索。", 409);
        cached = await this.content.cache(session, version, key);
        if (cached && cached.softExpiresAt > Date.now()) return await create(cached, "hit");
      }
      // Recheck after acquiring the lease to close the cache/lease race.
      cached = await this.content.cache(session, version, key);
      if (cached && cached.softExpiresAt > Date.now()) return await create(cached, "hit");
      for (let attempt = 0; attempt < 2; attempt++) {
        checkCancelled();
        if (Date.now() - started >= config.SEARCH_DEADLINE_MS) break;
        if (await this.content.version(session) !== version) throw new SearchError("SESSION_CLEARED", "本次会话数据已清除，请重新搜索。", 409);
        const reservation = await this.control.reserve(credential.scope);
        if (signal.aborted) { await this.control.settle(reservation, "free"); checkCancelled(); }
        const attemptStart = Date.now();
        let result: Awaited<ReturnType<typeof requestSearch>>;
        try { result = await this.provider(input.effectiveQuery, signal, credential.key); }
        catch (error) {
          const failure = error instanceof UpstreamFailure ? error : null;
          await recordRequest("upstream", String(failure?.status ?? "error"), Date.now() - attemptStart).catch(() => {});
          await this.control.settle(reservation, failure?.uncertain === false ? "free" : "uncertain");
          checkCancelled();
          if (failure && [401, 402].includes(failure.status)) {
            if (credential.source === "personal") {
              await rejectCredential(session, credential.scope, failure.status);
              throw new SearchError(failure.status === 401 ? "API_KEY_INVALID" : "API_BALANCE_INSUFFICIENT", failure.status === 401 ? "API key 无效，请在设置中更新。" : "API key 的账户余额不足，请充值后在设置中重新保存。", failure.status);
            }
            await this.control.trip(failure.status, credential.scope);
          }
          if (failure?.retryable && attempt === 0 && Date.now() - started + failure.retryDelay + 250 < config.SEARCH_DEADLINE_MS) {
            await sleep(failure.retryDelay, undefined, { signal }); continue;
          }
          if (error instanceof SearchError) throw error;
          if (cached && cached.hardExpiresAt > Date.now() && !input.timely && cached.results.length) return await create(cached, "stale");
          throw new SearchError("UPSTREAM_UNAVAILABLE", "暂时无法获取搜索结果，请稍后重试。", 502, true);
        }
        await this.control.settle(reservation, result.billed ? "billed" : "free");
        checkCancelled();
        await recordRequest("upstream", result.results.length ? "success" : "empty", Date.now() - attemptStart).catch(() => {});
        const fetchedAt = new Date().toISOString(); const now = Date.now();
        const ttl = result.results.length === 0 ? 15000 : input.timely ? 30000 : 300000;
        return await create({ results: result.results, fetchedAt, softExpiresAt: now + ttl, hardExpiresAt: now + (input.timely || !result.results.length ? ttl : 600000) }, "miss", true);
      }
      throw new SearchError("UPSTREAM_UNAVAILABLE", "搜索超时，请稍后重试。", 504, true);
    } catch (error) {
      checkCancelled(); throw error;
    } finally {
      clearTimeout(deadline); active.delete(controller); if (!active.size) tasks.delete(session);
      if (owned) await this.content.unlock(session, version, key, token).catch(() => {});
    }
  }
  async page(session: string, id: string, page: number, requestId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new SearchError("SNAPSHOT_EXPIRED", "本次搜索已过期或不可访问，请重新搜索。", 410);
    const snapshot = await this.content.snapshot(session, id);
    if (!snapshot || Date.parse(snapshot.expiresAt) <= Date.now()) throw new SearchError("SNAPSHOT_EXPIRED", "本次搜索已过期，请主动重新搜索。", 410);
    return paginate(snapshot, page, requestId);
  }
  async clear(session: string) {
    await this.content.clear(session);
    for (const task of tasks.get(session) ?? []) task.abort(new SearchError("SESSION_CLEARED", "本次会话数据已清除，请重新搜索。", 409));
  }
}
export const searchService = new SearchService(new RedisContentStore(), new RedisCostControl());
