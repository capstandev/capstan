import { CHANGELOG_COPY } from "../copy";
import releases from "../generated/releases.json";
import type { ChangelogEntry, ReleasePages } from "../../scripts/sync-releases";

const label = (e: ChangelogEntry) => (e.kind === "update" ? CHANGELOG_COPY.update(e.n!) : e.kind === "bonus" ? CHANGELOG_COPY.bonus(e.n!) : CHANGELOG_COPY.fix);

/** The released entries of CHANGELOG.md, newest first (parsed at build time by scripts/sync-releases.ts). */
export function Changelog({ entries = (releases as unknown as ReleasePages).changelog }: { entries?: ChangelogEntry[] }) {
  return (
    <article className="page cap-changelog">
      <h1>{CHANGELOG_COPY.title}</h1>
      {entries.length === 0 ? (
        <p data-changelog-empty="">{CHANGELOG_COPY.empty}</p>
      ) : (
        <ol className="stack">
          {entries.map((e, i) => (
            <li key={i} className="card" data-entry={e.kind} data-n={e.n ?? undefined}>
              <h2>
                {label(e)}: {e.line}
              </h2>
              <p className="cap-release-meta">{e.date ? <time dateTime={e.date}>{e.date}</time> : <span>{CHANGELOG_COPY.undated}</span>}</p>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
