import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: { include: ["tests/{unit,integration}/**/*.test.ts"], environment: "node", env: {
    APP_ORIGIN: "http://localhost:3333",
    SESSION_SECRET: "test-only-secret-at-least-thirty-two-characters",
    DEEPSEEK_API_KEY: "test-key-never-sent-to-provider",
    REDIS_CONTENT_URL: `redis://:deepsearch-test@${process.env.TEST_REDIS_HOST || "127.0.0.1"}:16379`,
    REDIS_CONTROL_URL: `redis://:deepsearch-test@${process.env.TEST_REDIS_HOST || "127.0.0.1"}:16380`,
  } },
});
