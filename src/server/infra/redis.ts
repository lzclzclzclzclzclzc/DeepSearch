import Redis from "ioredis";
import { getConfig } from "./config";
import { SearchError } from "@/shared/search";

type Connections = { content: Redis; control: Redis };
type ReadyConnections = Connections & { controlRunId: string };
const globalRedis = globalThis as typeof globalThis & { deepSearchRedis?: Connections; deepSearchRedisReady?: Promise<ReadyConnections> };
export function getRedis(): Connections {
  if (globalRedis.deepSearchRedis) return globalRedis.deepSearchRedis;
  const config = getConfig();
  const options = { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 1000, commandTimeout: 1500, retryStrategy: () => 1000 };
  const content = new Redis(config.REDIS_CONTENT_URL, options);
  const control = new Redis(config.REDIS_CONTROL_URL, options);
  // Connection errors are reported as redacted application errors, never raw URLs.
  content.on("error", () => {}); control.on("error", () => {});
  globalRedis.deepSearchRedis = { content, control };
  return globalRedis.deepSearchRedis;
}
export function readyRedis(): Promise<ReadyConnections> {
  if (!globalRedis.deepSearchRedisReady) globalRedis.deepSearchRedisReady = connectRedis().finally(() => { globalRedis.deepSearchRedisReady = undefined; });
  return globalRedis.deepSearchRedisReady;
}
async function connectRedis(): Promise<ReadyConnections> {
  const clients = getRedis();
  await Promise.all(Object.values(clients).map(async client => {
    if (client.status === "wait") await client.connect();
    if (client.status !== "ready") throw new Error("Redis unavailable");
  }));
  const infos = await Promise.all([clients.content.info("server"), clients.control.info("server")]);
  const ids = infos.map(info => /run_id:([^\r\n]+)/.exec(info)?.[1]);
  if (!ids[0] || !ids[1] || ids[0] === ids[1]) throw new Error("Content and control require independent Redis servers");
  return { ...clients, controlRunId: ids[1] };
}
export async function infrastructure<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof SearchError) throw error;
    throw new SearchError("SERVICE_UNAVAILABLE", "搜索服务暂时不可用，请稍后重试。", 503, true);
  }
}
