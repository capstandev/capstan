import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { ApiDocs } from "./pages/ApiDocs";
import { Landing } from "./pages/Landing";
import { Legal } from "./pages/Legal";
import { NotFound } from "./pages/NotFound";
import { Pricing } from "./pages/Pricing";
import { Status } from "./pages/Status";
import { Verify } from "./pages/Verify";

const Dashboard = lazy(() => import("./app/Dashboard").then((m) => ({ default: m.Dashboard })));

/** The public pages. The copy check, the accessibility test and the phone-width test walk this list. */
export const SITE_PAGES: { path: string; name: string; element: () => ReactNode }[] = [
  { path: "/", name: "landing", element: () => <Landing /> },
  { path: "/docs", name: "docs", element: () => <ApiDocs /> },
  { path: "/pricing", name: "pricing", element: () => <Pricing /> },
  { path: "/status", name: "status", element: () => <Status /> },
  { path: "/verify", name: "verify", element: () => <Verify /> },
  { path: "/legal", name: "legal", element: () => <Legal /> },
];

export function AppRoutes() {
  return (
    <Layout>
      <Routes>
        {SITE_PAGES.map((p) => (
          <Route key={p.path} path={p.path} element={p.element()} />
        ))}
        <Route
          path="/app/*"
          element={
            <Suspense fallback={<p role="status">Loading the dashboard.</p>}>
              <Dashboard />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
