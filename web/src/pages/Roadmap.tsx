import { ROADMAP_COPY } from "../copy";
import releases from "../generated/releases.json";
import type { ReleasePages, RoadmapBonus, RoadmapItem } from "../../scripts/sync-releases";

const data = releases as unknown as ReleasePages;

/** Every queued update grouped by day, in release order, with its time relative to launch, then the bonus updates.
 *  The data is made at build time (scripts/sync-releases.ts): an item reads LIVE only when the public CHANGELOG.md has
 *  its "Update N:" or "Bonus update N:" entry; every other one reads "planned". */
export function Roadmap({ updates = data.updates, bonuses = data.bonuses }: { updates?: RoadmapItem[]; bonuses?: RoadmapBonus[] }) {
  const days = [...new Set(updates.map((u) => u.day))].sort((a, b) => a - b);
  const badge = (live: boolean) => (
    <span className={live ? "cap-release-state ok" : "cap-release-state"} data-badge={live ? "live" : "planned"}>
      {live ? ROADMAP_COPY.live : ROADMAP_COPY.planned}
    </span>
  );
  return (
    <article className="page cap-roadmap">
      <h1>{ROADMAP_COPY.title}</h1>
      <p data-roadmap-intro>{ROADMAP_COPY.intro}</p>
      {days.map((d) => (
        <section key={d} aria-labelledby={`roadmap-day-${d}`}>
          <h2 id={`roadmap-day-${d}`}>{ROADMAP_COPY.day(d)}</h2>
          <ol className="stack">
            {updates
              .filter((u) => u.day === d)
              .sort((a, b) => a.hour - b.hour || a.n - b.n)
              .map((u) => (
                <li key={u.n} className="card" data-update={u.n}>
                  <h3>
                    {ROADMAP_COPY.update(u.n)}: {u.title}
                  </h3>
                  <p>{u.line}</p>
                  <p className="cap-release-meta">
                    <span data-at>{ROADMAP_COPY.slot(u.day, u.hour)}</span>
                    {badge(u.live)}
                  </p>
                </li>
              ))}
          </ol>
        </section>
      ))}
      {bonuses.length > 0 && (
        <section aria-labelledby="roadmap-bonus">
          <h2 id="roadmap-bonus">{ROADMAP_COPY.bonusTitle}</h2>
          <ol className="stack">
            {bonuses.map((b) => (
              <li key={b.n} className="card" data-bonus={b.key}>
                <h3>
                  {ROADMAP_COPY.bonus(b.n)}: {b.title}
                </h3>
                <p>{b.line}</p>
                <p className="cap-release-meta">
                  <span data-when={b.when}>{ROADMAP_COPY.when[b.when]}</span>
                  {badge(b.live)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
