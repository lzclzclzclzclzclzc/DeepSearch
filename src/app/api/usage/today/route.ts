import { api } from "@/server/infra/http";
import { dailyUsage } from "@/server/infra/control";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return api(request, () => dailyUsage(), { event: "usage" });
}
