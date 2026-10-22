import { randomUUID } from "node:crypto";
import type { SearchFilters } from "@/shared/search";
import { SearchError } from "@/shared/search";
import type { Evidence } from "@/server/deepseek/search";
import { getConfig } from "@/server/infra/config";
import { infrastructure, readyRedis } from "@/server/infra/redis";
import { recordSnapshotSize } from "@/server/infra/metrics";

export type CacheEntry = { results: Evidence[]; fetchedAt: string; softExpiresAt: number; hardExpiresAt: number };
export type Snapshot = { id: string; query: string; effectiveQuery: string; filters: SearchFilters; results: Evidence[]; fetchedAt: string; expiresAt: string; cache: "hit" | "miss" | "stale"; warnings: string[] };
export interface ContentStore {
  version(session: string): Promise<string>;
  cache(session: string, version: string, key: string): Promise<CacheEntry | null>;
  snapshot(session: string, id: string): Promise<Snapshot | null>;
  lock(session: string, version: string, key: string, token: string): Promise<boolean>;
  unlock(session: string, version: string, key: string, token: string): Promise<void>;
  commit(session: string, version: string, key: string, snapshot: Snapshot, cache?: CacheEntry): Promise<void>;
  clear(session: string): Promise<void>;
}
const prefix = (session: string) => `ds:content:${session}`;
export class RedisContentStore implements ContentStore {
  async version(session: string) { return infrastructure(async () => {
    const { content } = await readyRedis();
    const key = `${prefix(session)}:version`;
    await content.set(key, "1", "EX", 86400, "NX");
    return (await content.get(key))!;
  }); }
  async cache(session: string, version: string, key: string) { return infrastructure(async () => {
    const { content } = await readyRedis();
    const value = await content.get(`${prefix(session)}:${version}:cache:${key}`);
    return value ? JSON.parse(value) as CacheEntry : null;
  }); }
  async snapshot(session: string, id: string) { return infrastructure(async () => {
    const { content } = await readyRedis();
    const value = await content.eval(`
      local version = redis.call('GET', KEYS[1])
      if not version then return false end
      return redis.call('GET', ARGV[1] .. ':' .. version .. ':snapshot:' .. ARGV[2])
    `, 1, `${prefix(session)}:version`, prefix(session), id);
    return value ? JSON.parse(String(value)) as Snapshot : null;
  }); }
  async lock(session: string, version: string, key: string, token: string) { return infrastructure(async () => {
    const { content } = await readyRedis();
    return await content.set(`${prefix(session)}:${version}:lock:${key}`, token, "PX", getConfig().SEARCH_DEADLINE_MS + 2000, "NX") === "OK";
  }); }
  async unlock(session: string, version: string, key: string, token: string) { return infrastructure(async () => {
    const { content } = await readyRedis();
    await content.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, `${prefix(session)}:${version}:lock:${key}`, token);
  }); }
  async commit(session: string, version: string, key: string, snapshot: Snapshot, cache?: CacheEntry) { return infrastructure(async () => {
    const { content } = await readyRedis(); const config = getConfig();
    const snapshotJSON = JSON.stringify(snapshot); const cacheJSON = cache ? JSON.stringify(cache) : "";
    if (Buffer.byteLength(snapshotJSON) > 1_000_000 || Buffer.byteLength(cacheJSON) > 1_000_000) throw new Error("Snapshot exceeds limit");
    const root = prefix(session);
    const result = await content.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local snapshotKey = ARGV[2]
      redis.call('SET', snapshotKey, ARGV[3], 'EX', ARGV[4])
      redis.call('ZADD', KEYS[2], ARGV[5], snapshotKey)
      redis.call('ZADD', KEYS[3], ARGV[5], snapshotKey)
      if ARGV[6] ~= '' then
        redis.call('SET', ARGV[7], ARGV[6], 'PX', ARGV[8])
        redis.call('ZADD', KEYS[3], ARGV[5], ARGV[7])
      end
      while redis.call('ZCARD', KEYS[2]) > tonumber(ARGV[9]) do
        local old = redis.call('ZPOPMIN', KEYS[2], 1)
        redis.call('DEL', old[1]); redis.call('ZREM', KEYS[3], old[1])
      end
      while redis.call('ZCARD', KEYS[3]) > 100 do
        local old = redis.call('ZPOPMIN', KEYS[3], 1)
        redis.call('DEL', old[1]); redis.call('ZREM', KEYS[2], old[1])
      end
      redis.call('EXPIRE', KEYS[2], 86400); redis.call('EXPIRE', KEYS[3], 86400)
      redis.call('EXPIRE', KEYS[1], 86400)
      return 1
    `, 3, `${root}:version`, `${root}:${version}:snapshots`, `${root}:${version}:index`, version,
    `${root}:${version}:snapshot:${snapshot.id}`, snapshotJSON, config.SNAPSHOT_TTL_SECONDS, Date.now(), cacheJSON,
    `${root}:${version}:cache:${key}`, cache ? Math.max(1, cache.hardExpiresAt - Date.now()) : 1, config.MAX_SESSION_SNAPSHOTS);
    if (result !== 1) throw new SearchError("SESSION_CLEARED", "本次会话数据已清除，请重新搜索。", 409);
    await recordSnapshotSize(Buffer.byteLength(snapshotJSON)).catch(() => {});
  }); }
  async clear(session: string) { return infrastructure(async () => {
    const { content } = await readyRedis(); const root = prefix(session);
    await content.eval(`
      local version = redis.call('GET', KEYS[1])
      redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 86400)
      redis.call('DEL', ARGV[1] .. ':credential')
      if version then
        local index = ARGV[1] .. ':' .. version .. ':index'
        local keys = redis.call('ZRANGE', index, 0, -1)
        for _, key in ipairs(keys) do redis.call('DEL', key) end
        redis.call('DEL', index, ARGV[1] .. ':' .. version .. ':snapshots')
      end
      return 1
    `, 1, `${root}:version`, root);
  }); }
}
export const newSnapshotId = () => randomUUID();
