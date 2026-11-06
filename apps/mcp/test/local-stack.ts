// A local MCP endpoint for the inspector check: the MCP app on MCP_PORT (default 22113) in front of the local API built
// from the real route factories on fixture data (helpers.localApi). Prints "ready" when it listens.
import { createMcpApp } from "../src/server";
import { localApi } from "./helpers";

const port = Number(process.env.MCP_PORT ?? 22113);
const { api } = await localApi();
const app = createMcpApp({ api, version: "local", allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`], allowedOrigins: [] });
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`ready http://127.0.0.1:${port}/mcp`);
