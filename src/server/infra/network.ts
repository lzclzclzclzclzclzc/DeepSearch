import { isIP } from "node:net";

/** No socket address is exposed by Route Handlers. Only trust a proxy that overwrites this header. */
export function clientNetwork(request: Request, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  const address = request.headers.get("x-real-ip")?.trim();
  if (!address || address.includes("%")) return null;
  const family = isIP(address);
  if (family === 4) return address.split(".").slice(0, 3).join(".");
  if (family !== 6) return null;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail] = canonical.split("::");
  const first = head ? head.split(":") : []; const last = tail ? tail.split(":") : [];
  const groups = (canonical.includes("::") ? [...first, ...Array(8 - first.length - last.length).fill("0"), ...last] : first).map(part => Number.parseInt(part, 16));
  if (groups.slice(0, 5).every(part => part === 0) && groups[5] === 0xffff) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}`;
  return groups.slice(0, 4).map(part => part.toString(16)).join(":");
}
