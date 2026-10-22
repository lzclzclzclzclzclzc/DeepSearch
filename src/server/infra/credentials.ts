import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { SearchError } from "@/shared/search";
import { digest, getConfig } from "./config";
import { infrastructure, readyRedis } from "./redis";

type KeyState = "saved" | "invalid" | "balance";
type StoredCredential = { id: string; sealed: string; state: KeyState; expiresAt: string };
export type Credential = { key: string; source: "personal" | "server" | "none"; scope: string; state: KeyState };
const storageKey = (session: string) => `ds:content:${session}:credential`;
const encryptionKey = (session: string) => createHmac("sha256", getConfig().SESSION_SECRET).update(`credential:${session}`).digest();

export function sealKey(key: string, session: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(session), iv);
  cipher.setAAD(Buffer.from(session));
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function openKey(sealed: string, session: string) {
  const bytes = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(session), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(session)); decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
export async function resolveCredential(session: string): Promise<Credential> { return infrastructure(async () => {
  const { content } = await readyRedis(); const raw = await content.get(storageKey(session));
  if (raw) {
    const saved = JSON.parse(raw) as StoredCredential;
    return { key: openKey(saved.sealed, session), source: "personal", scope: saved.id, state: saved.state };
  }
  const key = getConfig().DEEPSEEK_API_KEY;
  return { key, source: key ? "server" : "none", scope: key ? digest(`server-key:${key}`) : "none", state: "saved" };
}); }
export async function credentialStatus(session: string) {
  const credential = await resolveCredential(session);
  return { configured: Boolean(credential.key), source: credential.source, state: credential.state };
}
const bodySchema = z.object({ apiKey: z.string().trim().min(10).max(256).regex(/^[\x21-\x7e]+$/) }).strict();
export async function saveCredential(session: string, raw: unknown, version?: string) {
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new SearchError("API_KEY_INVALID", "请输入有效的 API key，不要包含空格或换行。");
  return infrastructure(async () => {
    const { content } = await readyRedis();
    const versionKey = `ds:content:${session}:version`;
    if (!version) { await content.set(versionKey, "1", "EX", 86400, "NX"); version = (await content.get(versionKey))!; }
    const saved: StoredCredential = { id: randomUUID(), sealed: sealKey(parsed.data.apiKey, session), state: "saved", expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const result = await content.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'EX', 86400); redis.call('EXPIRE', KEYS[1], 86400); return 1
    `, 2, versionKey, storageKey(session), version, JSON.stringify(saved));
    if (result !== 1) throw new SearchError("SESSION_CLEARED", "会话数据已清除，请重新打开设置后保存。", 409);
    return { configured: true, source: "personal" as const, state: "saved" as const };
  });
}
export async function removeCredential(session: string) { return infrastructure(async () => {
  const { content } = await readyRedis(); await content.del(storageKey(session));
  return credentialStatus(session);
}); }
export async function rejectCredential(session: string, id: string, status: number) { return infrastructure(async () => {
  const { content } = await readyRedis();
  await content.eval(`
    local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
    local saved = cjson.decode(raw); if saved.id ~= ARGV[1] then return 0 end
    saved.state = ARGV[2]; redis.call('SET', KEYS[1], cjson.encode(saved), 'KEEPTTL'); return 1
  `, 1, storageKey(session), id, status === 401 ? "invalid" : "balance");
}); }
