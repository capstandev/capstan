import { useEffect, useState } from "react";
import { Table } from "../components/Table";
import { useConfig } from "../config";
import { STATUS_COPY } from "../copy";
import type { VenueCapabilities } from "../lib/capstan";

type Reading = { api: "checking" | "up" | "down"; venues: VenueCapabilities[] | null; at: string | null };

export function Status() {
  const cfg = useConfig();
  const [r, setR] = useState<Reading>({ api: "checking", venues: null, at: null });
  useEffect(() => {
    const f = cfg.fetch ?? fetch;
    const base = cfg.apiBase.replace(/\/$/, "");
    let alive = true;
    void (async () => {
      let api: Reading["api"] = "down";
      let venues: VenueCapabilities[] | null = null;
      try {
        const h = await f(`${base}/health`, { headers: { accept: "application/json" } });
        const j = (await h.json().catch(() => null)) as { ok?: boolean } | null;
        api = h.ok && j?.ok === true ? "up" : "down";
      } catch {
        api = "down";
      }
      try {
        const v = await f(`${base}/venues`, { headers: { accept: "application/json" } });
        if (v.ok) venues = (await v.json()) as VenueCapabilities[];
      } catch {
        venues = null;
      }
      if (alive) setR({ api, venues: Array.isArray(venues) ? venues : null, at: new Date((cfg.now ?? Date.now)()).toISOString() });
    })();
    return () => {
      alive = false;
    };
  }, [cfg]);
  const apiText = r.api === "up" ? STATUS_COPY.up : r.api === "down" ? STATUS_COPY.down : STATUS_COPY.checking;
  return (
    <article className="page">
      <h1>{STATUS_COPY.title}</h1>
      <p>{STATUS_COPY.intro}</p>
      <dl className="checks">
        <div data-status="api">
          <dt>{STATUS_COPY.api}</dt>
          <dd>{apiText}</dd>
        </div>
        {r.at ? (
          <div>
            <dt>Read at</dt>
            <dd>{r.at}</dd>
          </div>
        ) : null}
      </dl>
      <h2>{STATUS_COPY.venues}</h2>
      {r.venues ? (
        <Table label="Venue status" head={["Venue", "Access", "Integration fee"]} rows={r.venues.map((v) => [v.venue, v.execution ? STATUS_COPY.orders : STATUS_COPY.dataOnly, v.builderFee ? `${v.builderFee.chargeBps} bps (cap ${v.builderFee.capBps} bps)` : "none"])} />
      ) : (
        <p>{r.api === "checking" ? STATUS_COPY.checking : "The venue list could not be read."}</p>
      )}
    </article>
  );
}
