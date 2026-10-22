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
  console.log(JSON.stringify({ day, currentRunId: runId, approved: await redis.get("ds:control:approved_run_id") === runId,
    circuitOpen: Boolean(await redis.exists("ds:control:circuit")), usedCNY: Number(usage.used || 0) / 1000000,
    reservedCNY: Number(usage.reserved || 0) / 1000000, confirmedCNY: Number(usage.confirmed || 0) / 1000000,
    uncertainCNY: Number(usage.uncertain || 0) / 1000000, pending, uncertain }, null, 2));
  if (process.argv[2] === "approve") {
    const reviewed = process.argv.includes("--usage-reviewed");
    const acknowledged = process.argv.includes("--fresh-install");
    if (!reviewed && !acknowledged) throw new Error("Review supplier usage and pending reservations, then add --usage-reviewed. Use --fresh-install only for the first installation before any calls.");
    if (acknowledged && (await redis.exists(`ds:usage:${day}`) || pending || uncertain || await redis.exists("ds:control:approved_run_id"))) throw new Error("Existing accounting state found. Reconcile supplier usage and use --usage-reviewed.");
    const spentArg = process.argv.find(arg => arg.startsWith("--spent-cny="));
    if (reviewed) {
      if (!spentArg) throw new Error("--usage-reviewed requires --spent-cny=<supplier-confirmed-total-plus-unresolved-reservations>.");
      const spent = Math.ceil(Number(spentArg.split("=")[1]) * 1000000);
      if (!Number.isSafeInteger(spent) || spent < Number(usage.used || 0)) throw new Error("Reviewed spend must be valid and may not lower the conservative existing estimate.");
      await redis.hset(`ds:usage:${day}`, "used", spent); await redis.expire(`ds:usage:${day}`, 259200);
    }
    if (process.argv.includes("--clear-circuit")) await redis.del("ds:control:circuit");
    if (!runId) throw new Error("Cannot identify control Redis process");
    await redis.set("ds:control:approved_run_id", runId);
    console.log("Control Redis approved. Existing reserved and uncertain charges remain occupied.");
  } else if (process.argv[2] !== "status") throw new Error("Use status or approve");
} catch (error) {
  console.error(error instanceof Error && !/redis|connect|socket|ECONN/i.test(error.message) ? error.message : "Control operation failed. Check the Redis service and configuration."); process.exitCode = 1;
} finally { redis.disconnect(); }
