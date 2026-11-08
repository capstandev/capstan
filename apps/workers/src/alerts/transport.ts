// Pinned HTTPS transport: connects to the IP the guard checked, with the original host name for TLS (SNI and the
// certificate check) and the Host header. node:https never follows redirects; a 3xx is reported as a failure.
// timeoutMs is a total deadline, not only an idle one (R1-8-03): at the deadline, or when the caller aborts, the request
// and its socket are destroyed, so a host that trickles bytes cannot keep a socket open past the alert's budget.
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
  /** Aborting it destroys the request and its socket. */
  signal?: AbortSignal;
}

export type Transport = (r: PinnedRequest) => Promise<{ status: number; location?: string }>;

export const pinnedHttps: Transport = (r) =>
  new Promise((resolve, reject) => {
    if (r.signal?.aborted) return reject(new Error("aborted"));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => req.destroy(new Error("aborted"));
    const settle = () => {
      clearTimeout(deadline);
      r.signal?.removeEventListener("abort", onAbort);
    };
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
        settle();
        // the body is never read: drop the connection rather than let the host stream into it
        res.destroy();
        resolve({ status: res.statusCode ?? 0, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    deadline = setTimeout(() => req.destroy(new Error("timeout")), Math.max(0, r.timeoutMs));
    r.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => {
      settle();
      reject(e);
    });
    req.on("close", settle);
    req.end(r.body);
  });
