import { useState } from "react";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="button button-small"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setDone(true),
          () => setDone(false),
        );
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}
