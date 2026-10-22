import { randomBytes, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  DEEPSEEK_API_KEY: z.string().default(""),
  SESSION_SECRET: z.string().default(""),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  REDIS_CONTENT_URL: z.string().url().default("redis://127.0.0.1:6379"),
  REDIS_CONTROL_URL: z.string().url().default("redis://127.0.0.1:6380"),
  DAILY_BUDGET_CNY: z.coerce.number().nonnegative().max(100000).default(1),
  SEARCH_COST_MICROYUAN: positive(5000),
  SEARCH_QPS: positive(80),
  SESSION_SEARCHES_PER_MINUTE: positive(20),
  IP_SEARCHES_PER_MINUTE: positive(60),
  SEARCH_TIMEOUT_MS: positive(6000),
  SEARCH_DEADLINE_MS: positive(10000),
  SNAPSHOT_TTL_SECONDS: positive(1800),
  MAX_SESSION_SNAPSHOTS: positive(20),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  METRICS_TOKEN: z.string().default(""),
});
let config: ReturnType<typeof createConfig> | undefined;
function developmentSecret() {
  const directory = resolve(process.cwd(), ".runtime"); const path = resolve(directory, "session-secret");
  mkdirSync(directory, { recursive: true });
  try { writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return readFileSync(path, "utf8").trim();
}
function createConfig() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error("Invalid server configuration; check .env against .env.example");
  const value = parsed.data;
  if (process.env.NODE_ENV === "production" && (value.SESSION_SECRET.length < 32 || value.SESSION_SECRET.startsWith("replace-with-"))) throw new Error("SESSION_SECRET must contain at least 32 random characters");
  const secret = value.SESSION_SECRET || developmentSecret();
  return { ...value, SESSION_SECRET: secret, APP_ORIGIN: new URL(value.APP_ORIGIN).origin };
}
export const getConfig = () => config ??= createConfig();
export const digest = (value: string) => createHmac("sha256", getConfig().SESSION_SECRET).update(value).digest("hex");
