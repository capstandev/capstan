import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { FORK_BANNER, NAV, PUBLIC_APIS } from "../copy";
import { useConfig } from "../config";

export function Layout({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      {cfg.profile === "fork" ? (
        <p className="fork-banner" role="note" data-fork-banner="">
          {FORK_BANNER}
        </p>
      ) : null}
      <header className="site-header">
        <NavLink to="/" className="brand" end>
          Capstan
        </NavLink>
        <nav aria-label="Main">
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === "/"}>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <p>{PUBLIC_APIS}</p>
        <p>
          <NavLink to="/legal">Legal and risk</NavLink>
        </p>
      </footer>
    </>
  );
}
