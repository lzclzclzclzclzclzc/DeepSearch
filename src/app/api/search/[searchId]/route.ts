import { api } from "@/server/infra/http";
import { searchService } from "@/server/search/service";
import { SearchError } from "@/shared/search";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ searchId: string }> }) {
  return api(request, async ctx => {
    const { searchId } = await params; const raw = new URL(request.url).searchParams.get("page") ?? "1";
    if (!/^[1-9]\d*$/.test(raw)) throw new SearchError("INVALID_PAGE", "页码必须为正整数。");
    return searchService.page(ctx.session, searchId, Number(raw), ctx.requestId);
  }, { event: "page" });
}
