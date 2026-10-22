import { readyRedis } from "@/server/infra/redis";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  let ready = false;
  try {
    await readyRedis();
    ready = true;
  } catch { /* Health never includes configuration values. */ }
  return Response.json({ status: ready ? "ready" : "unavailable" }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
