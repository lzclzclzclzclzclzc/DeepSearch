import { describe, expect, it } from "vitest";
import { openKey, sealKey } from "@/server/infra/credentials";
describe("personal key encryption", () => {
  it("encrypts independently with authenticated encryption and a session-specific key", () => {
    const key = "not-a-real-key-only-for-unit-tests"; const first = sealKey(key, "session-one"); const second = sealKey(key, "session-one");
    expect(first).not.toContain(key); expect(second).not.toBe(first); expect(openKey(first, "session-one")).toBe(key);
    expect(() => openKey(first, "session-two")).toThrow();
    const altered = Buffer.from(first, "base64"); altered[altered.length - 1] ^= 1;
    expect(() => openKey(altered.toString("base64"), "session-one")).toThrow();
  });
});
