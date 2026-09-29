import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getConfig } from "./config.js";
import { issueState, requireServiceToken, constantTimeEqual, verifyState } from "./auth.js";
import { GoogleHealthClient } from "./google-health.js";
import { createMcpServer } from "./mcp.js";
import { openApi } from "./openapi.js";
import { isOAuthError, McpOAuthServer } from "./mcp-oauth.js";

export function createApp() {
  const config = getConfig();
  const client = new GoogleHealthClient(config);
  const oauth = new McpOAuthServer(config);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  app.get("/", (_req, res) => res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Evans Health Reader</title></head>
<body><main style="max-width:720px;margin:10vh auto;font:18px system-ui;padding:24px;line-height:1.6">
<h1>Evans Health Reader</h1>
<p>A private, read-only connector that lets its owner retrieve and summarize personal health data after Google OAuth consent.</p>
<p>OAuth tokens are encrypted at rest. This service does not sell health data, is not affiliated with Google or Fitbit, and is not a medical device.</p>
<nav><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></nav>
</main></body></html>`));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "google-health-mobile" }));
  app.get("/openapi.json", (_req, res) => res.json(openApi(config.baseUrl)));
  app.get("/privacy", (_req, res) => res.type("html").send(page("Privacy", "Health data is fetched only after your Google consent. OAuth tokens are encrypted at rest. This personal service does not sell health data. Disconnecting deletes the locally stored token.")));
  app.get("/terms", (_req, res) => res.type("html").send(page("Terms", "This unofficial, read-only beta connector is not affiliated with Google or Fitbit. It is not a medical device and does not provide medical advice.")));

  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(oauth.protectedResourceMetadata()));
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(oauth.protectedResourceMetadata()));
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(oauth.authorizationServerMetadata()));
  app.post("/oauth/register", async (req, res) => {
    try { res.status(201).json(await oauth.registerClient(req.body)); }
    catch (error) { sendOAuthError(res, error); }
  });
  app.get("/oauth/authorize", async (req, res) => {
    try {
      const request = await oauth.validateAuthorizationRequest(req.query as Record<string, unknown>);
      res.type("html").send(authorizationPage(request));
    } catch (error) { sendOAuthError(res, error); }
  });
  app.post("/oauth/authorize", async (req, res) => {
    let request: Awaited<ReturnType<typeof oauth.validateAuthorizationRequest>> | undefined;
    try {
      request = await oauth.validateAuthorizationRequest(req.body as Record<string, unknown>);
      res.redirect(303, await oauth.approveAuthorization(request, String(req.body.personal_key ?? "")));
    } catch (error) {
      if (request && isOAuthError(error)) {
        const redirect = new URL(request.redirectUri);
        redirect.searchParams.set("error", error.oauthCode);
        redirect.searchParams.set("error_description", error.message);
        if (request.state) redirect.searchParams.set("state", request.state);
        redirect.searchParams.set("iss", oauth.issuer);
        res.redirect(303, redirect.toString());
      } else sendOAuthError(res, error);
    }
  });
  app.post("/oauth/token", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json(await oauth.token(req.body));
    } catch (error) { sendOAuthError(res, error); }
  });

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

  app.options("/mcp", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.status(204).end();
  });
  app.post("/mcp", oauth.requireMcpToken(), async (req, res) => {
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
  return { app, config, oauth };
}

function page(title: string, body: string) { return `<!doctype html><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><main style="max-width:680px;margin:10vh auto;font:18px system-ui;padding:24px"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>`; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }

function authorizationPage(request: {
  responseType: string; clientId: string; redirectUri: string; codeChallenge: string;
  codeChallengeMethod: string; state: string; scope: string; resource: string;
}) {
  const hidden = Object.entries({
    response_type: request.responseType, client_id: request.clientId, redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod,
    state: request.state, scope: request.scope, resource: request.resource
  }).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Connect Google Health</title>
  <main style="max-width:560px;margin:8vh auto;font:17px system-ui;padding:24px;line-height:1.5">
    <h1>Connect ChatGPT to Google Health</h1>
    <p>This grants read-only access to the Google Health account already connected to this personal service.</p>
    <ul><li>Health status and summaries</li><li>Steps, sleep, heart, weight and other supported metrics</li><li>Recorded exercise sessions</li></ul>
    <form method="post" action="/oauth/authorize">${hidden}
      <label>Personal connection key<br><input type="password" name="personal_key" required autocomplete="current-password" style="box-sizing:border-box;width:100%;padding:10px;margin:8px 0 16px"></label>
      <button type="submit" style="padding:10px 18px">Allow read-only access</button>
    </form>
    <p style="color:#555;font-size:14px">The key is submitted directly to your service and is not shared with the model.</p>
  </main>`;
}

function sendOAuthError(res: express.Response, error: unknown) {
  if (isOAuthError(error)) {
    res.status(error.status).json({ error: error.oauthCode, error_description: error.message });
    return;
  }
  res.status(500).json({ error: "server_error", error_description: "OAuth request failed" });
}

if (process.env.NODE_ENV !== "test") {
  const { app, config } = createApp();
  app.listen(config.port, "0.0.0.0", () => console.log(`Google Health Mobile listening on :${config.port}`));
}
