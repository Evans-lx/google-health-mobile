import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getConfig } from "./config.js";
import { issueState, requireServiceToken, constantTimeEqual, verifyState } from "./auth.js";
import { GoogleHealthClient } from "./google-health.js";
import { createMcpServer } from "./mcp.js";
import { openApi } from "./openapi.js";

export function createApp() {
  const config = getConfig();
  const client = new GoogleHealthClient(config);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "google-health-mobile" }));
  app.get("/openapi.json", (_req, res) => res.json(openApi(config.baseUrl)));
  app.get("/privacy", (_req, res) => res.type("html").send(page("Privacy", "Health data is fetched only after your Google consent. OAuth tokens are encrypted at rest. This personal service does not sell health data. Disconnecting deletes the locally stored token.")));
  app.get("/terms", (_req, res) => res.type("html").send(page("Terms", "This unofficial, read-only beta connector is not affiliated with Google or Fitbit. It is not a medical device and does not provide medical advice.")));

  app.get("/connect", (req, res) => {
    const setupToken = String(req.query.token ?? "");
    if (!constantTimeEqual(setupToken, config.setupToken)) return res.status(401).type("text").send("Invalid setup token");
    res.redirect(client.authorizationUrl(issueState(config)));
  });
  app.get("/oauth/google/callback", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const state = String(req.query.state ?? "");
      if (!code || !verifyState(config, state)) return res.status(400).type("text").send("Invalid or expired OAuth response");
      await client.exchangeCode(code);
      res.type("html").send(page("Connected", "Google Health is connected. You may close this page and return to ChatGPT."));
    } catch (error) { res.status(500).type("text").send(`Connection failed: ${escapeHtml((error as Error).message)}`); }
  });

  const api = express.Router();
  api.use(requireServiceToken(config));
  api.get("/status", async (_req, res, next) => { try { res.json(await client.status()); } catch (error) { next(error); } });
  api.get("/summary", async (req, res, next) => { try { res.json(await client.summary(String(req.query.start), String(req.query.end))); } catch (error) { next(error); } });
  api.get("/exercises", async (req, res, next) => { try { res.json(await client.exercises(String(req.query.start), String(req.query.end))); } catch (error) { next(error); } });
  api.get("/data/:dataType", async (req, res, next) => { try {
    const aggregate = String(req.query.aggregate ?? "true") !== "false";
    res.json({ data_type: req.params.dataType, start: req.query.start, end: req.query.end, data: await client.query(req.params.dataType, String(req.query.start), String(req.query.end), aggregate) });
  } catch (error) { next(error); } });
  app.use("/api", api);

  app.post("/mcp", requireServiceToken(config), async (req, res) => {
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }); }
    finally { await transport.close().catch(() => undefined); await server.close().catch(() => undefined); }
  });

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = /must|invalid|unsupported|range/i.test(error.message) ? 400 : 502;
    res.status(status).json({ error: error.message.replace(/(access_token|refresh_token|client_secret)[^,}]*/gi, "$1=[redacted]").slice(0, 500) });
  });
  return { app, config };
}

function page(title: string, body: string) { return `<!doctype html><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><main style="max-width:680px;margin:10vh auto;font:18px system-ui;padding:24px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>`; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }

if (process.env.NODE_ENV !== "test") {
  const { app, config } = createApp();
  app.listen(config.port, "0.0.0.0", () => console.log(`Google Health Mobile listening on :${config.port}`));
}
