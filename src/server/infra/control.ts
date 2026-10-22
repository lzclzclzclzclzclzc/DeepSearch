import { randomUUID } from "node:crypto";
import { SearchError } from "@/shared/search";
import { getConfig } from "./config";
import { infrastructure, readyRedis } from "./redis";

export interface CostControl {
  rate(session: string, ip: string | null): Promise<void>;
  reserve(circuit?: string, kind?: "search" | "fetch" | "model", estimate?: number): Promise<string>;
  settle(id: string, state: "billed" | "free" | "uncertain", actual?: number): Promise<void>;
  trip(status: number, circuit?: string): Promise<void>;
}
export const budgetDay = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
export class RedisCostControl implements CostControl {
  async rate(session: string, ip: string | null) { return infrastructure(async () => {
    const { control } = await readyRedis(); const config = getConfig(); const minute = Math.floor(Date.now() / 60000);
    const result = await control.eval(`
      local a = redis.call('INCR', KEYS[1]); if a == 1 then redis.call('EXPIRE', KEYS[1], 120) end
      local b = 0
      if #KEYS > 1 then b = redis.call('INCR', KEYS[2]); if b == 1 then redis.call('EXPIRE', KEYS[2], 120) end end
      if a > tonumber(ARGV[1]) or b > tonumber(ARGV[2]) then return 0 end return 1
    `, ip === null ? 1 : 2, `ds:rate:session:${session}:${minute}`, ...(ip === null ? [] : [`ds:rate:ip:${ip}:${minute}`]), config.SESSION_SEARCHES_PER_MINUTE, config.IP_SEARCHES_PER_MINUTE);
    if (result !== 1) throw new SearchError("RATE_LIMITED", "搜索过于频繁，请稍后再试。", 429, true, 60 - Math.floor(Date.now() / 1000) % 60);
  }); }
  async reserve(circuit = "default", kind: "search" | "fetch" | "model" = "search", estimate?: number) { return infrastructure(async () => {
    const { control } = await readyRedis(); const config = getConfig(); const day = budgetDay(); const id = `${day}:${kind}:${randomUUID()}`;
    const amount = estimate ?? (kind === "fetch" ? config.FETCH_COST_MICROYUAN : config.SEARCH_COST_MICROYUAN);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Invalid cost estimate");
    const qps = kind === "fetch" ? config.FETCH_QPS : kind === "model" ? config.SUMMARY_QPS : config.SEARCH_QPS;
    const result = Number(await control.eval(`
      if redis.call('EXISTS', KEYS[1]) == 1 then return -2 end
      redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[1]) - 1000)
      if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return -3 end
      redis.call('ZADD', KEYS[2], ARGV[1], ARGV[4]); redis.call('EXPIRE', KEYS[2], 2)
      redis.call('HINCRBY', KEYS[3], 'used', ARGV[3]); redis.call('HINCRBY', KEYS[3], 'reserved', ARGV[3])
      redis.call('HINCRBY', KEYS[3], 'attempts', 1)
      redis.call('HSET', KEYS[4], ARGV[4], ARGV[3]); redis.call('EXPIRE', KEYS[3], 259200); redis.call('EXPIRE', KEYS[4], 259200)
      return 1
    `, 4, `ds:control:circuit:${circuit}`, `ds:control:${kind}_qps`, `ds:usage:${day}`, `ds:pending:${day}`,
    Date.now(), qps, amount, id));
    if (result === -3) throw new SearchError("RATE_LIMITED", "搜索服务繁忙，请稍后重试。", 429, true, 1);
    if (result !== 1) throw new SearchError("SERVICE_UNAVAILABLE", "搜索服务暂时不可用，请联系维护者。", 503);
    return id;
  }); }
  async settle(id: string, state: "billed" | "free" | "uncertain", actual?: number) { return infrastructure(async () => {
    const { control } = await readyRedis(); const day = id.slice(0, 10);
    if (actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0)) throw new Error("Invalid actual cost");
    const kind = id.split(":")[1]; const paidCounter = kind === "model" ? "modelCalls" : kind === "fetch" ? "fetchCalls" : "paidCalls";
    await control.eval(`
      local amount = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
      if amount == 0 then return 0 end
      redis.call('HDEL', KEYS[2], ARGV[1]); redis.call('HINCRBY', KEYS[1], 'reserved', -amount)
      if ARGV[2] == 'free' then redis.call('HINCRBY', KEYS[1], 'used', -amount); redis.call('HINCRBY', KEYS[1], 'freeCalls', 1)
      elseif ARGV[2] == 'billed' then
        local actual = tonumber(ARGV[3]); if actual < 0 then actual = amount end
        redis.call('HINCRBY', KEYS[1], 'used', actual - amount); redis.call('HINCRBY', KEYS[1], 'confirmed', actual)
        redis.call('HINCRBY', KEYS[1], ARGV[4], 1)
      else redis.call('HINCRBY', KEYS[1], 'uncertain', amount); redis.call('HSET', KEYS[3], ARGV[1], amount); redis.call('EXPIRE', KEYS[3], 259200) end
      return 1
    `, 3, `ds:usage:${day}`, `ds:pending:${day}`, `ds:uncertain:${day}`, id, state, actual ?? -1, paidCounter);
  }); }
  async trip(status: number, circuit = "default") { return infrastructure(async () => {
    const { control } = await readyRedis(); await control.set(`ds:control:circuit:${circuit}`, String(status), "EX", 300);
  }); }
}

export async function dailyUsage() { return infrastructure(async () => {
  const { control } = await readyRedis(); const day = budgetDay();
  const usage = await control.hgetall(`ds:usage:${day}`);
  const amount = (field: string) => Math.max(0, Number(usage[field] || 0)) / 1_000_000;
  return { day, timeZone: "Asia/Shanghai" as const, totalCny: amount("used"), confirmedCny: amount("confirmed"), pendingCny: amount("reserved"), uncertainCny: amount("uncertain"), attempts: Number(usage.attempts || 0), paidSearches: Number(usage.paidCalls || 0), summaries: Number(usage.modelCalls || 0), fetches: Number(usage.fetchCalls || 0) };
}); }
