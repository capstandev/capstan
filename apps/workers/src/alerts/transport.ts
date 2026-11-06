// Pinned HTTPS transport: connects to the IP the guard checked, with the original host name for TLS (SNI and the
// certificate check) and the Host header. node:https never follows redirects; a 3xx is reported as a failure.
import { request } from "node:https";

export interface PinnedRequest {
  ip: string;
  family: 4 | 6;
  host: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export type Transport = (r: PinnedRequest) => Promise<{ status: number; location?: string }>;

export const pinnedHttps: Transport = (r) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: r.host,
        servername: r.host,
        port: r.port,
        path: r.path,
        method: "POST",
        headers: { ...r.headers, host: r.port === 443 ? r.host : `${r.host}:${r.port}`, "content-length": String(Buffer.byteLength(r.body)) },
        timeout: r.timeoutMs,
        // the only name lookup is the guard's: answer with the checked IP
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: r.ip, family: r.family }]) : cb(null, r.ip, r.family))) as never,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(r.body);
  });
