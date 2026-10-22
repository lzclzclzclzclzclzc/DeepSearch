import { api, readJSON } from "@/server/infra/http";
import { credentialStatus, removeCredential, saveCredential } from "@/server/infra/credentials";
import { RedisContentStore } from "@/server/search/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return api(request, ctx => credentialStatus(ctx.session), { event: "config" });
}
export async function POST(request: Request) {
  return api(request, async ctx => {
    const version = await new RedisContentStore().version(ctx.session);
    return saveCredential(ctx.session, await readJSON(request), version);
  }, { write: true, event: "config" });
}
export async function DELETE(request: Request) {
  return api(request, ctx => removeCredential(ctx.session), { write: true, event: "config" });
}
