// R1 SSRF table; R2 no DNS rebinding: the request goes only to the IP the guard checked on that same lookup.
import { describe, expect, test } from "bun:test";
import { guardUrl, isPublicIp } from "../../src/alerts";

const pub = async () => ["93.184.216.34"];

describe("outbound URL guard", () => {
  test("ssrf-table", async () => {
    const refused: [string, string[] | null, string][] = [
      ["http://hooks.example.com/x", null, "https only"],
      ["ftp://hooks.example.com/x", null, "https only"],
      ["https://user:pw@hooks.example.com/x", null, "user name or password"],
      ["https://user@hooks.example.com/x", null, "user name or password"],
      ["https://hooks.example.com:8080/x", null, "port 443 or 8443"],
      ["https://hooks.example.com:6379/x", null, "port 443 or 8443"],
      ["https://hooks.example.com:5432/x", null, "port 443 or 8443"],
      ["https://localhost/x", null, "private host name"],
      ["https://relay.internal/x", null, "private host name"],
      ["https://127.0.0.1/x", null, "private"],
      ["https://127.1.2.3/x", null, "private"],
      ["https://2130706433/x", null, "private"], // decimal 127.0.0.1
      ["https://0x7f000001/x", null, "private"],
      ["https://10.1.2.3/x", null, "private"],
      ["https://172.16.0.1/x", null, "private"],
      ["https://172.31.255.255/x", null, "private"],
      ["https://192.168.1.1/x", null, "private"],
      ["https://169.254.169.254/latest/meta-data/", null, "private"], // cloud metadata
      ["https://100.64.0.1/x", null, "private"], // CGNAT
      ["https://0.0.0.0/x", null, "private"],
      ["https://224.0.0.1/x", null, "private"], // multicast
      ["https://255.255.255.255/x", null, "private"],
      ["https://[::1]/x", null, "private"],
      ["https://[::]/x", null, "private"],
      ["https://[fc00::1]/x", null, "private"],
      ["https://[fd12:3456::1]/x", null, "private"],
      ["https://[fe80::1]/x", null, "private"],
      ["https://[ff02::1]/x", null, "private"],
      ["https://[::ffff:127.0.0.1]/x", null, "private"], // IPv4-mapped loopback
      ["https://[::ffff:169.254.169.254]/x", null, "private"],
      ["https://[::ffff:a9fe:a9fe]/x", null, "private"], // the same, hex form
      ["https://[::ffff:10.0.0.1]/x", null, "private"],
      ["https://[64:ff9b::a00:1]/x", null, "private"], // NAT64 of 10.0.0.1
      ["https://[2002:7f00:1::1]/x", null, "private"], // 6to4 of 127.0.0.1
      ["https://hooks.example.com/x", ["10.0.0.5"], "private"], // a public name pointing inside
      ["https://hooks.example.com/x", ["93.184.216.34", "127.0.0.1"], "private"], // mixed answer
      ["https://hooks.example.com/x", ["::ffff:192.168.0.1"], "private"],
      ["https://hooks.example.com/x", [], "does not resolve"],
      ["not a url", null, "not a URL"],
    ];
    for (const [url, addrs, reason] of refused) {
      const g = await guardUrl(url, async () => addrs ?? ["93.184.216.34"]);
      expect(g.ok, url).toBe(false);
      if (!g.ok) expect(g.reason, url).toContain(reason);
    }
    // a public https host on 443 or 8443 passes, with the checked IP, host and path (query kept for the request only)
    const ok = await guardUrl("https://hooks.example.com/alerts?x=1", pub);
    expect(ok).toEqual({ ok: true, ip: "93.184.216.34", family: 4, host: "hooks.example.com", port: 443, path: "/alerts?x=1" });
    expect((await guardUrl("https://hooks.example.com:8443/a", pub)).ok).toBe(true);
    expect((await guardUrl("https://[2606:4700:4700::1111]/a", pub)).ok).toBe(true);
    expect(await guardUrl("https://hooks.example.com/a", async () => ["2606:4700::6810:84e5"])).toMatchObject({ ok: true, family: 6 });
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("172.32.0.1")).toBe(true); // just outside 172.16/12
    expect(isPublicIp("100.128.0.1")).toBe(true); // just outside 100.64/10
  });

  test("no-rebinding", async () => {
    // the resolver answers public first and private next: each lookup is checked, and the request carries the IP of
    // the lookup that passed; a later private answer is refused before any connection
    let n = 0;
    const flip = async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const first = await guardUrl("https://rebind.example.com/hook", flip);
    expect(first).toMatchObject({ ok: true, ip: "93.184.216.34" });
    const second = await guardUrl("https://rebind.example.com/hook", flip);
    expect(second.ok).toBe(false);
    // the guard resolves exactly once per call: the IP it returns is the one it checked
    let calls = 0;
    await guardUrl("https://once.example.com/", async () => (calls++, ["93.184.216.34"]));
    expect(calls).toBe(1);
  });
});
