import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { SearchError, type ApiError } from "@/shared/search";
import { digest, getConfig } from "./config";
import { recordRequest } from "./metrics";
import { createSessionCookie, sessionCookieName, verifySession } from "./session";

type Context = { requestId: string; session: string; ip: string };
function readSession(request: Request): string | null {
  const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
  return verifySession(cookie);
}
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== getConfig().APP_ORIGIN || request.headers.get("sec-fetch-site") === "cross-site") throw new SearchError("FORBIDDEN", "请从本站页面发起操作。", 403);
}
export async function readJSON(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new SearchError("INVALID_QUERY", "请使用 JSON 格式提交搜索。");
  if (Number(request.headers.get("content-length")) > 4096) throw new SearchError("INVALID_QUERY", "提交内容过长。", 413);
  const reader = request.body?.getReader(); if (!reader) throw new SearchError("INVALID_QUERY", "请输入搜索词。");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new SearchError("INVALID_QUERY", "提交内容过长。", 413); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new SearchError("INVALID_QUERY", "无法读取搜索请求，请重试。"); }
}
export async function api(request: Request, handler: (ctx: Context) => Promise<unknown>, options: { write?: boolean; createSession?: boolean; event: string }) {
  const requestId = randomUUID(); const started = Date.now(); let fresh: ReturnType<typeof createSessionCookie> | null = null; let status = 200; let code = "OK";
  let response: NextResponse;
  try {
    if (options.write) sameOrigin(request);
    let session = readSession(request);
    if (!session && options.createSession) { fresh = createSessionCookie(); session = fresh.id; }
    if (!session) throw new SearchError("SNAPSHOT_EXPIRED", "本次搜索已过期或不可访问，请重新搜索。", 410);
    const rawIP = getConfig().TRUST_PROXY === "true" ? request.headers.get("x-real-ip") ?? "untrusted" : "untrusted";
    // Store only a daily salted coarse network identifier, never a complete IP.
    const coarseIP = rawIP.includes(":") ? rawIP.split(":").slice(0, 4).join(":") : rawIP.split(".").slice(0, 3).join(".");
    const data = await handler({ requestId, session: digest(session), ip: digest(`${new Date().toISOString().slice(0, 10)}:${coarseIP}`) });
    response = data instanceof Response ? new NextResponse(data.body, { status: data.status, headers: data.headers }) : NextResponse.json(data);
  } catch (error) {
    const known = error instanceof SearchError ? error : new SearchError("SERVICE_UNAVAILABLE", "搜索服务暂时不可用，请稍后重试。", 503, true);
    status = known.status; code = known.code;
    response = NextResponse.json({ error: { code: known.code, message: known.message, retryable: known.retryable }, requestId } satisfies ApiError, { status });
    if (known.retryAfter) response.headers.set("Retry-After", String(known.retryAfter));
  }
  if (fresh) response.cookies.set(sessionCookieName, fresh.value, fresh.options);
  response.headers.set("Cache-Control", "private, no-store"); response.headers.set("X-Request-Id", requestId);
  const elapsed = Date.now() - started;
  console.info(JSON.stringify({ event: options.event, requestId, status, code, elapsedMs: elapsed }));
  await recordRequest(options.event, code, elapsed).catch(() => {});
  return response;
}
