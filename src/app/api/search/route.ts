import { api, readJSON } from "@/server/infra/http";
import { searchService } from "@/server/search/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return api(request, async ctx => searchService.search(await readJSON(request), ctx.session, ctx.ip, ctx.requestId), { write: true, createSession: true, event: "search" });
}
