import { DISCLAIMER } from "../copy";

/** The risk disclaimer block (DECISIONS #13). `compact` is the one-paragraph form used inside widgets. */
export function Disclaimer({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="disclaimer disclaimer-compact" data-disclaimer="">
        <strong>{DISCLAIMER.title}:</strong> {DISCLAIMER.lines.join(" ")}
      </p>
    );
  }
  return (
    <section className="disclaimer" aria-labelledby="disclaimer-title" data-disclaimer="">
      <h2 id="disclaimer-title">{DISCLAIMER.title}</h2>
      <ul>
        {DISCLAIMER.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
