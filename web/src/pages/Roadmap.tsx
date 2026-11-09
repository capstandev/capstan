import { ROADMAP_COPY } from "../copy";
import releases from "../generated/releases.json";
import type { ReleasePages, RoadmapItem } from "../../scripts/sync-releases";

/** Every queued update grouped by day, in release order. The data is made at build time (scripts/sync-releases.ts):
 *  an update reads LIVE only when the public CHANGELOG.md has its "Update N:" entry; every other one reads "planned". */
export function Roadmap({ updates = (releases as unknown as ReleasePages).updates }: { updates?: RoadmapItem[] }) {
  const days = [...new Set(updates.map((u) => u.day))].sort((a, b) => a - b);
  return (
    <article className="page cap-roadmap">
      <h1>{ROADMAP_COPY.title}</h1>
      {days.map((d) => (
        <section key={d} aria-labelledby={`roadmap-day-${d}`}>
          <h2 id={`roadmap-day-${d}`}>{ROADMAP_COPY.day(d)}</h2>
          <ol className="stack">
            {updates
              .filter((u) => u.day === d)
              .sort((a, b) => a.slot - b.slot || a.n - b.n)
              .map((u) => (
                <li key={u.n} className="card" data-update={u.n}>
                  <h3>
                    {ROADMAP_COPY.update(u.n)}: {u.title}
                  </h3>
                  <p>{u.line}</p>
                  <p className="cap-release-meta">
                    <span>{ROADMAP_COPY.slot(u.day, u.slot)}</span>
                    <span className={u.live ? "cap-release-state ok" : "cap-release-state"} data-badge={u.live ? "live" : "planned"}>
                      {u.live ? ROADMAP_COPY.live : ROADMAP_COPY.planned}
                    </span>
                  </p>
                </li>
              ))}
          </ol>
        </section>
      ))}
    </article>
  );
}
