import { describe, expect, it } from "vitest";
import { clientNetwork } from "@/server/infra/network";
const request = (address?: string) => new Request("http://localhost:3333/api/search", { headers: address ? { "X-Real-IP": address } : {} });
describe("trusted client network", () => {
  it("does not trust client-supplied forwarding headers by default", () => {
    expect(clientNetwork(request("203.0.113.1"), false)).toBeNull();
    expect(clientNetwork(request(), false)).toBeNull();
  });
  it.each([undefined, "untrusted", "203.0.113.1, 192.0.2.1", "999.0.0.1", "fe80::1%eth0"])("ignores missing or malformed proxy addresses: %s", address => {
    expect(clientNetwork(request(address), true)).toBeNull();
  });
  it.each([
    ["192.0.2.1", "192.0.2"], ["192.0.2.254", "192.0.2"],
    ["2001:db8::1", "2001:db8:0:0"], ["2001:0DB8:0000:0:0:0:0:2", "2001:db8:0:0"],
    ["2001:db8:12:34:abcd::5", "2001:db8:12:34"], ["::1", "0:0:0:0"], ["::ffff:192.0.2.1", "192.0.2"],
  ])("normalizes %s without storing a complete address", (address, expected) => expect(clientNetwork(request(address), true)).toBe(expected));
});
