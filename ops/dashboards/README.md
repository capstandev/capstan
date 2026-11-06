# Dashboards

- Every service serves Prometheus text metrics at `GET /metrics` on `127.0.0.1:<PROM_PORT>` (`@capstan/telemetry`,
  `startMetricsServer`). VPS ports: api 9710, ws 9711, relay 9712, mcp 9713, facilitator 9714, workers 9715.
- `prometheus.yml`: scrape config for a local Prometheus on the VPS.
- `dashboard.json`: Grafana dashboard (import it, pick the Prometheus data source). One panel per metric in
  `METRICS` (spec 14): quote staleness, venue budget use per egress IP, order funnel, onboarding prompts, builder fee
  per venue per day, unmatched fills, unhedged plans, x402 settle failures, venue latency.
- Spans: each service appends one JSON line per span to `OTLP_FILE` (OTLP field names). Alerts go to the internal
  ops group through the `ops-alerts` worker; causes are in `../alerts/GLOSSARY.md`.
- Where each metric comes from: api (quote staleness per leg, order funnel build and sign, onboarding prompts shown
  and signed), relay (funnel submit, venue budget use after each acquire, venue latency, refusals by code), workers
  (builder fee from the reconciler, unmatched fills and unhedged plans from ops-alerts, job runs and failures per
  job), facilitator (x402 settles and settle failures per network), mcp (tool calls per tool), ws (open
  connections). Every HTTP service also counts `capstan_http_requests_total{service}`.
- Traces: the api's request span is carried in the relay-submit job data (`traceparent`), the relay worker continues
  it, and every venue call from the relay is a CLIENT span that sends `traceparent` and records venue latency.
  Worker jobs continue a producer's trace the same way.
