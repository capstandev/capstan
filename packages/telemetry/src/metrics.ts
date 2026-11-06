// Prometheus text-format metrics with no extra dependency: counters, gauges and histograms with at most one label,
// rendered by `renderMetrics()` and served at GET /metrics by `metricsHandler()` or `startMetricsServer(port)`.
// The METRICS set is the spec 14 list; every member has a recording helper below that the services call, so a test
// can drive each code path and read it back from /metrics (rule R2).

type LabelValue = string;

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly label: string | null,
  ) {}
  abstract readonly type: "counter" | "gauge" | "histogram";
  abstract render(): string[];
  abstract reset(): void;
  protected lbl(v: LabelValue | undefined, extra?: string): string {
    const parts: string[] = [];
    if (this.label && v !== undefined) parts.push(`${this.label}="${escapeLabel(v)}"`);
    if (extra) parts.push(extra);
    return parts.length ? `{${parts.join(",")}}` : "";
  }
  protected header(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function fmt(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

export class Counter<L extends string = never> extends Metric {
  readonly type = "counter" as const;
  private values = new Map<string, number>();
  inc(...args: [L] extends [never] ? [by?: number] : [label: L, by?: number]): void {
    const [a, b] = args as unknown[];
    const key = this.label ? String(a) : "";
    const by = (this.label ? b : a) as number | undefined;
    const d = by ?? 1;
    if (!(d >= 0) || !Number.isFinite(d)) throw new Error(`${this.name}: a counter only goes up (got ${d})`);
    this.values.set(key, (this.values.get(key) ?? 0) + d);
  }
  get(label?: L): number {
    return this.values.get(this.label ? String(label) : "") ?? 0;
  }
  render(): string[] {
    const out = this.header();
    for (const [k, v] of this.values) out.push(`${this.name}${this.lbl(this.label ? k : undefined)} ${fmt(v)}`);
    return out;
  }
  reset(): void {
    this.values.clear();
  }
}

export class Gauge<L extends string = never> extends Metric {
  readonly type = "gauge" as const;
  private values = new Map<string, number>();
  set(...args: [L] extends [never] ? [value: number] : [label: L, value: number]): void {
    const [a, b] = args as unknown[];
    const key = this.label ? String(a) : "";
    const v = (this.label ? b : a) as number;
    if (!Number.isFinite(v)) throw new Error(`${this.name}: gauge value must be finite`);
    this.values.set(key, v);
  }
  get(label?: L): number | undefined {
    return this.values.get(this.label ? String(label) : "");
  }
  render(): string[] {
    const out = this.header();
    for (const [k, v] of this.values) out.push(`${this.name}${this.lbl(this.label ? k : undefined)} ${fmt(v)}`);
    return out;
  }
  reset(): void {
    this.values.clear();
  }
}

interface HistState {
  buckets: number[];
  sum: number;
  count: number;
}

export class Histogram<L extends string = never> extends Metric {
  readonly type = "histogram" as const;
  private values = new Map<string, HistState>();
  constructor(
    name: string,
    help: string,
    label: string | null,
    readonly bounds: readonly number[],
  ) {
    super(name, help, label);
    for (let i = 1; i < bounds.length; i++) if (!(bounds[i]! > bounds[i - 1]!)) throw new Error(`${name}: bucket bounds must increase`);
  }
  observe(...args: [L] extends [never] ? [value: number] : [label: L, value: number]): void {
    const [a, b] = args as unknown[];
    const key = this.label ? String(a) : "";
    const v = (this.label ? b : a) as number;
    if (!Number.isFinite(v)) throw new Error(`${this.name}: observation must be finite`);
    let s = this.values.get(key);
    if (!s) this.values.set(key, (s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < this.bounds.length; i++) if (v <= this.bounds[i]!) s.buckets[i]!++;
    s.sum += v;
    s.count++;
  }
  count(label?: L): number {
    return this.values.get(this.label ? String(label) : "")?.count ?? 0;
  }
  render(): string[] {
    const out = this.header();
    for (const [k, s] of this.values) {
      const lv = this.label ? k : undefined;
      this.bounds.forEach((b, i) => out.push(`${this.name}_bucket${this.lbl(lv, `le="${fmt(b)}"`)} ${s.buckets[i]}`));
      out.push(`${this.name}_bucket${this.lbl(lv, 'le="+Inf"')} ${s.count}`);
      out.push(`${this.name}_sum${this.lbl(lv)} ${fmt(s.sum)}`);
      out.push(`${this.name}_count${this.lbl(lv)} ${s.count}`);
    }
    return out;
  }
  reset(): void {
    this.values.clear();
  }
}

const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000, 30000] as const;

export type FunnelStage = "build" | "sign" | "submit";
export type OnboardingPromptState = "shown" | "signed" | "declined";

/** Spec 14 metrics. Names are stable: dashboards and alert rules read them. */
export const METRICS = {
  quoteStalenessMs: new Histogram<string>("capstan_quote_staleness_ms", "Age of the venue data behind a quote, per venue", "venue", MS_BUCKETS),
  governorUsePct: new Gauge<string>("capstan_governor_use_pct", "Venue request budget used per egress IP and venue (percent of the venue limit)", "budget"),
  funnel: new Counter<FunnelStage>("capstan_order_funnel_total", "Order funnel: builds, signed envelopes received, submits", "stage"),
  onboardingPrompt: new Counter<OnboardingPromptState>("capstan_onboarding_prompt_total", "Onboarding wallet prompts shown, signed and declined", "state"),
  builderFeeUsd: new Counter<string>("capstan_builder_fee_usd_total", "Builder fee accrued in USD per venue (from reconciliation)", "venue"),
  unmatchedFills: new Gauge("capstan_unmatched_fills", "Fills carrying the builder that match no Capstan order (last reconciliation day)", null),
  unhedgedPlans: new Gauge("capstan_unhedged_plans", "Spread plans with one leg filled and the other not", null),
  x402SettleFail: new Counter<string>("capstan_x402_settle_fail_total", "x402 settlements that failed, per network", "network"),
  venueLatencyMs: new Histogram<string>("capstan_venue_latency_ms", "Venue response time per venue", "venue", MS_BUCKETS),
} as const;

export type MetricName = keyof typeof METRICS;

/** Per-service health metrics every app emits on its own paths (besides the spec 14 set above). */
export const SERVICE_METRICS = {
  httpRequests: new Counter<string>("capstan_http_requests_total", "HTTP requests served, per service", "service"),
  jobRuns: new Counter<string>("capstan_job_runs_total", "Worker job runs finished, per job", "job"),
  jobFailures: new Counter<string>("capstan_job_failures_total", "Worker job runs that threw, per job", "job"),
  mcpToolCalls: new Counter<string>("capstan_mcp_tool_calls_total", "MCP tool calls, per tool", "tool"),
  wsConnections: new Gauge("capstan_ws_connections", "Open WebSocket connections", null),
  relayRefusals: new Counter<string>("capstan_relay_refusals_total", "Relay submits refused, per error code", "code"),
  x402Settled: new Counter<string>("capstan_x402_settled_total", "x402 settlements that succeeded, per network", "network"),
} as const;

export function renderMetrics(extra: readonly Metric[] = []): string {
  const lines: string[] = [];
  for (const m of [...Object.values(METRICS), ...Object.values(SERVICE_METRICS), ...extra]) lines.push(...m.render());
  return lines.join("\n") + "\n";
}

export function resetMetrics(): void {
  for (const m of [...Object.values(METRICS), ...Object.values(SERVICE_METRICS)]) m.reset();
}

/** Read one sample back from the rendered text (tests and the status script): `name{label="v"}` or `name`. */
export function metricValue(text: string, name: string, label?: { key: string; value: string }): number | null {
  const want = label ? `${name}{${label.key}="${escapeLabel(label.value)}"}` : name;
  for (const line of text.split("\n")) if (line.startsWith(want + " ")) return Number(line.slice(want.length + 1));
  return null;
}

export const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** GET /metrics handler (any framework that speaks Request/Response). */
export function metricsHandler(): (req: Request) => Response {
  return (req) => {
    if (new URL(req.url).pathname !== "/metrics") return new Response("not found", { status: 404 });
    return new Response(renderMetrics(), { headers: { "content-type": PROM_CONTENT_TYPE } });
  };
}

/** Separate metrics listener on 127.0.0.1 (the VPS scrapes it locally; Caddy never exposes it). */
export function startMetricsServer(port: number, hostname = "127.0.0.1"): { port: number; stop(): void } {
  const srv = Bun.serve({ port, hostname, fetch: metricsHandler() });
  return { port: srv.port ?? port, stop: () => srv.stop(true) };
}

// ---- recording helpers: the code paths the services call ----

/** Quote engine: age of the data behind a quote leg. */
export function recordQuoteStaleness(venue: string, stalenessMs: number): void {
  METRICS.quoteStalenessMs.observe(venue, Math.max(0, stalenessMs));
}

/** Venue governor: share of the per-egress budget in use, as a percent. */
export function recordGovernorUse(egress: string, venue: string, usedPct: number): void {
  METRICS.governorUsePct.set(`${egress}:${venue}`, Math.max(0, usedPct));
}

export function recordFunnel(stage: FunnelStage): void {
  METRICS.funnel.inc(stage);
}

export function recordOnboardingPrompt(state: OnboardingPromptState): void {
  METRICS.onboardingPrompt.inc(state);
}

/** Reconciler: builder fee accrued for one venue (decimal string or number, USD). */
export function recordBuilderFee(venue: string, usd: string | number): void {
  const v = typeof usd === "string" ? Number(usd) : usd;
  if (!Number.isFinite(v) || v < 0) throw new Error("recordBuilderFee: fee must be a finite non-negative number");
  METRICS.builderFeeUsd.inc(venue, v);
}

export function recordUnmatchedFills(n: number): void {
  METRICS.unmatchedFills.set(n);
}

export function recordUnhedgedPlans(n: number): void {
  METRICS.unhedgedPlans.set(n);
}

export function recordX402SettleFailure(network: string): void {
  METRICS.x402SettleFail.inc(network);
}

export function recordVenueLatency(venue: string, ms: number): void {
  METRICS.venueLatencyMs.observe(venue, Math.max(0, ms));
}
