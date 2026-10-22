import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { getConfig } from "@/server/infra/config";
import { readyRedis, infrastructure } from "@/server/infra/redis";
import { SearchError } from "@/shared/search";

export class AnswerStore {
  readonly root: string;
  constructor(readonly session: string, readonly version: string, readonly searchId: string, readonly expiresAt: string) { this.root = `ds:content:${session}:${version}`; }
  async valid() {
    const { content } = await readyRedis();
    if (await content.get(`ds:content:${this.session}:version`) !== this.version) throw new SearchError("SESSION_CLEARED", "会话已清除，请重新搜索。", 409);
    if (Date.parse(this.expiresAt) <= Date.now() || !await content.exists(`${this.root}:snapshot:${this.searchId}`)) throw new SearchError("SNAPSHOT_EXPIRED", "搜索结果已过期，请重新搜索后生成总结。", 410);
  }
  async read<T>(key: string): Promise<T | null> { return infrastructure(async () => {
    await this.valid(); const { content } = await readyRedis(); const value = await content.get(`${this.root}:${key}`); return value ? JSON.parse(value) as T : null;
  }); }
  async write(key: string, value: unknown, maxAge = Infinity) { return infrastructure(async () => {
    const { content } = await readyRedis(); const ttl = Math.min(Date.parse(this.expiresAt) - Date.now(), maxAge);
    if (ttl < 1) throw new SearchError("SNAPSHOT_EXPIRED", "搜索结果已过期，请重新搜索。", 410);
    const result = await content.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      if redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
      redis.call('SET', KEYS[3], ARGV[2], 'PX', ARGV[3]); redis.call('ZADD', KEYS[4], ARGV[4], KEYS[3])
      while redis.call('ZCARD', KEYS[4]) > 100 do local old = redis.call('ZPOPMIN', KEYS[4], 1); redis.call('DEL', old[1]) end
      redis.call('EXPIRE', KEYS[4], 86400); return 1
    `, 4, `ds:content:${this.session}:version`, `${this.root}:snapshot:${this.searchId}`, `${this.root}:${key}`, `${this.root}:index`, this.version, JSON.stringify(value), Math.floor(ttl), Date.now());
    if (result !== 1) throw new SearchError("SESSION_CLEARED", "会话已清除或搜索已过期，请重新搜索。", 409);
  }); }
  async claim(key: string, requestId: string, token: string) { return infrastructure(async () => {
    await this.valid(); const { content } = await readyRedis();
    const result = Number(await content.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -3 end
      if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
      if redis.call('EXISTS', KEYS[3]) == 1 then return -2 end
      if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
      redis.call('SET', KEYS[4], ARGV[2], 'PX', ARGV[3]); redis.call('SET', KEYS[3], 'started', 'PX', ARGV[4])
      redis.call('ZADD', KEYS[5], ARGV[5], KEYS[3]); redis.call('EXPIRE', KEYS[5], 86400); return 1
    `, 5, `ds:content:${this.session}:version`, `${this.root}:${key}`, `${this.root}:${key}:request:${requestId}`, `${this.root}:${key}:lock`, `${this.root}:index`, this.version, token, getConfig().SUMMARY_TIMEOUT_MS + 3000, Math.max(1, Date.parse(this.expiresAt) - Date.now()), Date.now()));
    if (result === -3) throw new SearchError("SESSION_CLEARED", "会话已清除，请重新搜索。", 409);
    if (result <= 0) throw new SearchError("RATE_LIMITED", result === -2 ? "上次总结未完成，请再次点击生成。" : "本次总结正在生成，请稍候。", 409, true);
    return result === 1;
  }); }
  async release(key: string, token: string) { const { content } = await readyRedis(); await content.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, `${this.root}:${key}:lock`, token); }
}

/** A shared expiring lease limits all instances; a bounded FIFO waits at most 1s. */
export async function acquireSummarySlot(signal: AbortSignal) {
  const { control } = await readyRedis(); const token = randomUUID(); const config = getConfig(); const start = Date.now();
  try {
    while (!signal.aborted && Date.now() - start < 1000) {
      const now = Date.now();
      const result = Number(await control.eval(`
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
        if not redis.call('ZSCORE', KEYS[2], ARGV[2]) then
          if redis.call('ZCARD', KEYS[2]) >= 10 then return -1 end
          redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2]); redis.call('EXPIRE', KEYS[2], 3)
        end
        if redis.call('ZRANK', KEYS[2], ARGV[2]) == 0 and redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
          redis.call('ZREM', KEYS[2], ARGV[2]); redis.call('ZADD', KEYS[1], ARGV[5], ARGV[2]); redis.call('PEXPIRE', KEYS[1], ARGV[6]); return 1
        end return 0
      `, 2, "ds:summary:active", "ds:summary:queue", now, token, start + 1100, config.SUMMARY_CONCURRENCY, now + config.SUMMARY_TIMEOUT_MS + 3000, config.SUMMARY_TIMEOUT_MS + 5000));
      if (result === 1) return async () => { await control.zrem("ds:summary:active", token); };
      if (result === -1) break;
      await sleep(40, undefined, { signal }).catch(() => {});
    }
    signal.throwIfAborted(); throw new SearchError("RATE_LIMITED", "总结服务繁忙，请稍后重试。", 429, true, 1);
  } finally { await control.zrem("ds:summary:queue", token).catch(() => {}); }
}
