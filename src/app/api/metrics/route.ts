import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/server/infra/config";
import { readyRedis } from "@/server/infra/redis";
import { budgetDay } from "@/server/infra/control";
import { renderMetrics } from "@/server/infra/metrics";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const expected = Buffer.from(`Bearer ${getConfig().METRICS_TOKEN}`); const actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (!getConfig().METRICS_TOKEN || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return new Response(null, { status: 404 });
  try {
    const { control } = await readyRedis(); const usage = await control.hgetall(`ds:usage:${budgetDay()}`);
    const text = await renderMetrics() + ["used", "reserved", "confirmed", "uncertain"].map(state => `deepsearch_daily_cost_yuan{state="${state}"} ${Number(usage[state] ?? 0) / 1_000_000}`).join("\n") + "\n";
    return new Response(text, { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
  } catch { return new Response("unavailable\n", { status: 503 }); }
}
