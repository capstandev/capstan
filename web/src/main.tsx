import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppRoutes } from "./App";
import { ConfigContext, configFromEnv } from "./config";
import "./styles.css";

const config = configFromEnv(import.meta.env as unknown as Record<string, string | boolean | undefined>);
const el = document.getElementById("root");
if (!el) throw new Error("no #root element");
createRoot(el).render(
  <StrictMode>
    <ConfigContext.Provider value={config}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ConfigContext.Provider>
  </StrictMode>,
);
