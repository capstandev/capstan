import type { ReactNode } from "react";

/** A table inside a labelled region that scrolls on its own at phone width (the page never scrolls sideways). */
export function Table({ label, head, rows, className }: { label: string; head: ReactNode[]; rows: ReactNode[][]; className?: string }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className={className}>
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
