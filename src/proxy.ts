import { NextRequest, NextResponse } from "next/server";
import { createSessionCookie, sessionCookieName, verifySession } from "@/server/infra/session";
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (!verifySession(request.cookies.get(sessionCookieName)?.value)) {
    const cookie = createSessionCookie(); response.cookies.set(sessionCookieName, cookie.value, cookie.options);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = { matcher: ["/", "/search"] };
