import { api } from "@/server/infra/http";
import { searchService } from "@/server/search/service";
export const runtime = "nodejs";
export async function DELETE(request: Request) {
  return api(request, async ctx => { await searchService.clear(ctx.session); return { cleared: true, requestId: ctx.requestId }; }, { write: true, event: "clear" });
}
