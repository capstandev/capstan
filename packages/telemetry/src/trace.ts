// Traces across api -> relay -> venue with W3C traceparent (spec 14). Free-only: spans go to an OTLP-style JSON
// lines file (one span per line) and, when asked, stdout; no collector or paid backend.
//
// How a trace crosses the services:
//   api      tel.serve(handler) starts a SERVER span from the request's traceparent (or a new trace)
//   queue    tel.jobData(data) adds the current traceparent to a BullMQ job's data
//   relay    tel.fromJob(job.data, name, fn) continues that trace in the worker
//   venue    tel.venueFetch(venue) sends traceparent to the venue and records a CLIENT span + venue latency
import type { Role } from "@capstan/core";
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, hrTimeToNanoseconds, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { recordVenueLatency, startMetricsServer } from "./metrics";
import { redact } from "./redact";

export type Carrier = Record<string, string | undefined>;

const propagator = new W3CTraceContextPropagator();
const setter = { set: (c: Carrier, k: string, v: string) => void (c[k] = v) };
const getter = {
  keys: (c: Carrier) => Object.keys(c),
  get: (c: Carrier, k: string) => {
    const hit = Object.keys(c).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit === undefined ? undefined : c[hit];
  },
};

let contextReady = false;
function ensureContextManager(): void {
  if (contextReady) return;
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  context.setGlobalContextManager(cm);
  propagation.setGlobalPropagator(propagator);
  contextReady = true;
}

/** Writes each finished span as one JSON line (OTLP field names, attributes redacted). */
export class JsonLinesSpanExporter implements SpanExporter {
  constructor(
    private readonly service: string,
    private readonly write: (line: string) => void,
  ) {}
  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    try {
      for (const s of spans) this.write(JSON.stringify(spanToJson(this.service, s)));
      done({ code: ExportResultCode.SUCCESS });
    } catch (e) {
      done({ code: ExportResultCode.FAILED, error: e as Error });
    }
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export function spanToJson(service: string, s: ReadableSpan): Record<string, unknown> {
  const sc = s.spanContext();
  return {
    resource: { "service.name": service },
    traceId: sc.traceId,
    spanId: sc.spanId,
    parentSpanId: s.parentSpanContext?.spanId ?? null,
    name: s.name,
    kind: SpanKind[s.kind],
    startTimeUnixNano: String(hrTimeToNanoseconds(s.startTime)),
    endTimeUnixNano: String(hrTimeToNanoseconds(s.endTime)),
    attributes: redact({ ...s.attributes }),
    status: { code: SpanStatusCode[s.status.code], ...(s.status.message ? { message: s.status.message } : {}) },
  };
}

export interface TelemetryOptions {
  otlpFile?: string; // JSON lines span file
  promPort?: number; // separate 127.0.0.1 listener for GET /metrics
  stdout?: boolean; // also print spans to stdout
  memory?: boolean; // keep finished spans in memory (tests)
}

export interface Telemetry {
  service: Role;
  tracer: Tracer;
  /** Finished spans kept in memory (only with opts.memory). */
  finished(): ReadableSpan[];
  /** Run fn in a new span (child of the active one or of `parent`). Errors set the span status and rethrow. */
  span<T>(name: string, fn: (span: Span) => Promise<T> | T, o?: { kind?: SpanKind; attributes?: Attributes; parent?: Context }): Promise<T>;
  /** traceparent (and tracestate) for the active span, written into the carrier. */
  inject<C extends Carrier>(carrier?: C): C;
  extract(carrier: Carrier): Context;
  /** Wrap a fetch-style handler: one SERVER span per request, continuing the caller's traceparent. */
  serve(handler: (req: Request) => Response | Promise<Response>): (req: Request) => Promise<Response>;
  /** Job data with the current traceparent added (enqueue side). */
  jobData<D extends Record<string, unknown>>(data: D): D & { traceparent?: string };
  /** Continue the trace carried in job data (worker side). */
  fromJob<T>(data: { traceparent?: unknown } | null | undefined, name: string, fn: (span: Span) => Promise<T> | T): Promise<T>;
  /** A fetch that sends traceparent to the venue, in a CLIENT span that records the venue latency metric. */
  venueFetch(venue: string, base?: typeof fetch): typeof fetch;
  /** trace_id and span_id of the active span, for log lines. */
  logFields(): { trace_id?: string; span_id?: string };
  shutdown(): Promise<void>;
}

export function initTelemetry(service: Role, opts: TelemetryOptions = {}): Telemetry {
  ensureContextManager();
  const memory = new InMemorySpanExporter();
  const processors = [];
  if (opts.memory) processors.push(new SimpleSpanProcessor({ exporter: memory }));
  if (opts.otlpFile) {
    const file = opts.otlpFile;
    mkdirSync(dirname(file), { recursive: true });
    processors.push(new SimpleSpanProcessor({ exporter: new JsonLinesSpanExporter(service, (l) => appendFileSync(file, l + "\n")) }));
  }
  if (opts.stdout) processors.push(new SimpleSpanProcessor({ exporter: new JsonLinesSpanExporter(service, (l) => process.stdout.write(l + "\n")) }));
  const provider = new TracerProvider({ spanProcessors: processors });
  const tracer = provider.getTracer(`capstan-${service}`);
  const prom = opts.promPort ? startMetricsServer(opts.promPort) : null;

  const span: Telemetry["span"] = (name, fn, o = {}) => {
    const parent = o.parent ?? context.active();
    return tracer.startActiveSpan(name, { kind: o.kind ?? SpanKind.INTERNAL, attributes: o.attributes }, parent, async (s) => {
      try {
        const r = await fn(s);
        s.setStatus({ code: SpanStatusCode.OK });
        return r;
      } catch (e) {
        s.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error)?.name ?? "error" });
        throw e;
      } finally {
        s.end();
      }
    });
  };

  const inject = <C extends Carrier>(carrier?: C): C => {
    const c = (carrier ?? {}) as C;
    propagator.inject(context.active(), c, setter);
    return c;
  };
  const extract = (carrier: Carrier): Context => propagator.extract(ROOT_CONTEXT, carrier, getter);

  return {
    service,
    tracer,
    finished: () => memory.getFinishedSpans(),
    span,
    inject,
    extract,
    serve(handler) {
      return async (req: Request) => {
        const headers: Carrier = {};
        req.headers.forEach((v, k) => (headers[k] = v));
        const url = new URL(req.url);
        return span(
          `${req.method} ${url.pathname}`,
          async (s) => {
            const res = await handler(req);
            s.setAttribute("http.response.status_code", res.status);
            return res;
          },
          { kind: SpanKind.SERVER, parent: extract(headers), attributes: { "http.request.method": req.method, "url.path": url.pathname, "service.role": service } },
        );
      };
    },
    jobData(data) {
      const c = inject({} as Carrier);
      return c.traceparent ? { ...data, traceparent: c.traceparent } : { ...data };
    },
    fromJob(data, name, fn) {
      const tp = data && typeof data.traceparent === "string" ? data.traceparent : undefined;
      return span(name, fn, { kind: SpanKind.CONSUMER, parent: tp ? extract({ traceparent: tp }) : ROOT_CONTEXT });
    },
    venueFetch(venue, base = fetch) {
      const f = async (input: string | URL | Request, init?: RequestInit) =>
        span(
          `venue ${venue}`,
          async (s) => {
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            const c = inject({} as Carrier);
            for (const [k, v] of Object.entries(c)) if (v) headers.set(k, v);
            const t0 = performance.now();
            try {
              const res = await base(input, { ...init, headers });
              s.setAttribute("http.response.status_code", res.status);
              return res;
            } finally {
              recordVenueLatency(venue, performance.now() - t0);
            }
          },
          { kind: SpanKind.CLIENT, attributes: { "capstan.venue": venue } },
        );
      return f as typeof fetch;
    },
    logFields() {
      const s = trace.getSpan(context.active());
      if (!s) return {};
      const sc = s.spanContext();
      return { trace_id: sc.traceId, span_id: sc.spanId };
    },
    async shutdown() {
      prom?.stop();
      await provider.shutdown();
    },
  };
}

/** Telemetry options from the environment: OTLP_FILE (span file) and PROM_PORT (metrics listener). */
export function telemetryEnv(env: Record<string, string | undefined>): TelemetryOptions {
  const port = env.PROM_PORT ? Number(env.PROM_PORT) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error("telemetry: PROM_PORT must be a port number");
  return { otlpFile: env.OTLP_FILE || undefined, promPort: port };
}
