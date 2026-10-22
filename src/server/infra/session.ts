import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "./config";
export const sessionCookieName = "ds_session";
function signature(id: string) { return createHmac("sha256", getConfig().SESSION_SECRET).update(id).digest("base64url"); }
export function verifySession(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const [id, signed, extra] = cookie.split(".");
  if (!id || !signed || extra || !/^[a-f0-9]{48}$/.test(id)) return null;
  const expected = Buffer.from(signature(id)); const actual = Buffer.from(signed);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
}
export function createSessionCookie() {
  const id = randomBytes(24).toString("hex");
  return { id, value: `${id}.${signature(id)}`, options: { httpOnly: true, sameSite: "lax" as const, secure: new URL(getConfig().APP_ORIGIN).protocol === "https:", path: "/", maxAge: 86400 } };
}
