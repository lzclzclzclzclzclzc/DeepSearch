import { api, readJSON } from "@/server/infra/http";
import { generateAnswer, readAnswer } from "@/server/answer/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ searchId: string }> };
export async function POST(request: Request, context: Context) {
  return api(request, async ctx => generateAnswer(ctx.session, ctx.ip, (await context.params).searchId, await readJSON(request), request.signal), { write: true, event: "answer" });
}
export async function GET(request: Request, context: Context) {
  return api(request, async ctx => readAnswer(ctx.session, (await context.params).searchId), { event: "answer_read" });
}
