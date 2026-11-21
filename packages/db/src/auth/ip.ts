import { isIPv4, isIPv6 } from "node:net";

/**
 * The client's IP prefix (IPv4 /24, IPv6 /48), read only from the one header
 * an operator configured (AUTH_TRUSTED_IP_HEADER, e.g. cf-connecting-ip behind
 * Cloudflare). X-Forwarded-For is never read: any client can send it. Without
 * a configured header, or with a value that is not exactly one address, the
 * IP is unknown (null). The full address is never kept.
 */
export function clientIpPrefix(headers: Headers, trustedHeader: string | null): string | null {
  if (!trustedHeader) return null;
  const raw = headers.get(trustedHeader)?.trim();
  if (!raw) return null;
  return ipPrefix(raw);
}

export function ipPrefix(address: string): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const v4 = mapped ? mapped[1]! : address;
  if (isIPv4(v4)) {
    const [a, b, c] = v4.split(".");
    return `${Number(a)}.${Number(b)}.${Number(c)}.0/24`;
  }
  if (isIPv6(address)) {
    const groups = expandIPv6(address);
    if (!groups) return null;
    const head = groups.slice(0, 3).map((g) => g.toString(16));
    return `${head.join(":")}::/48`;
  }
  return null;
}

/** The 8 groups of an IPv6 address (no zone id), or null. */
function expandIPv6(address: string): number[] | null {
  if (address.includes("%")) return null;
  const [left, right] = address.split("::") as [string, string | undefined];
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const l = parse(left);
  const r = right === undefined ? [] : parse(right);
  if (l.concat(r).some((g) => g.includes("."))) return null;
  const missing = 8 - l.length - r.length;
  if (missing < 0 || (right === undefined && missing !== 0)) return null;
  return [...l, ...Array<string>(missing).fill("0"), ...r].map((g) => parseInt(g, 16));
}
