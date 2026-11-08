import type { ReactNode } from "react";

/** The verify page for one receipt. A plain link: the site is multi-page, so it leaves the dashboard. */
export const verifyHref = (id: string) => `verify.html?id=${encodeURIComponent(id)}`;

export function VerifyLink({ id, children }: { id: string; children: ReactNode }) {
  return <a href={verifyHref(id)}>{children}</a>;
}
