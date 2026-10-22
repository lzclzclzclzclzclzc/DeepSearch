import Redis from "ioredis";

// This tool intentionally outputs only accounting state, never connection URLs.
const redis = new Redis(process.env.REDIS_CONTROL_URL || "redis://127.0.0.1:6380", { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2000, retryStrategy: () => null });
redis.on("error", () => {});
try {
  await redis.connect();
  const info = await redis.info("server"); const runId = /run_id:([^\r\n]+)/.exec(info)?.[1];
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const usage = await redis.hgetall(`ds:usage:${day}`);
  const pending = await redis.hlen(`ds:pending:${day}`); const uncertain = await redis.hlen(`ds:uncertain:${day}`);
  console.log(JSON.stringify({ day, currentRunId: runId, unlimited: true, usedCNY: Number(usage.used || 0) / 1000000,
    reservedCNY: Number(usage.reserved || 0) / 1000000, confirmedCNY: Number(usage.confirmed || 0) / 1000000,
    uncertainCNY: Number(usage.uncertain || 0) / 1000000, pending, uncertain }, null, 2));
  if (process.argv[2] !== "status") throw new Error("Use status");
} catch (error) {
  console.error(error instanceof Error && !/redis|connect|socket|ECONN/i.test(error.message) ? error.message : "Control operation failed. Check the Redis service and configuration."); process.exitCode = 1;
} finally { redis.disconnect(); }
