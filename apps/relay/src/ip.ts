// Rate-limit buckets by client address (audit REL-2): an IPv4 address is its own bucket (/32); an IPv6 address shares a
// bucket with its /64, so one host cannot dodge a per-IP limit by walking its own prefix. IPv4-mapped IPv6 addresses
// count as the IPv4 address. Anything unreadable becomes one shared "unknown" bucket (strict, never unlimited).
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4(s: string): string | null {
  const m = V4.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts.join(".");
}

/** Expand an IPv6 text address to 8 groups of 16 bits, or null. Accepts an embedded IPv4 tail and a zone id. */
export function ipv6Groups(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const a = v4(maybeV4);
    if (!a) return null;
    const p = a.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  const want = 8;
  let groups: number[];
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    if (head.length !== want) return null;
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

/** The rate-limit bucket of a client address: `v4:<a.b.c.d>` or `v6:<first four groups>::/64`. */
export function ipBucket(ip: string): string {
  const a = v4(ip.trim());
  if (a) return `v4:${a}`;
  const g = ipv6Groups(ip);
  if (!g) return "unknown";
  // ::ffff:a.b.c.d is an IPv4 client
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `v4:${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `v6:${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}
