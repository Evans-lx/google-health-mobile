import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { issueState, verifyState } from "../src/auth.js";
import { EncryptedTokenStore } from "../src/crypto-store.js";
import { civilDateRange, dataPointFilter, redact, validateDate } from "../src/google-health.js";
import { openApi } from "../src/openapi.js";
import { McpOAuthServer } from "../src/mcp-oauth.js";
import { createHash, randomBytes } from "node:crypto";

const config = { setupToken: "setup-secret" } as Parameters<typeof issueState>[0];

test("signed setup state verifies and rejects tampering", () => {
  const state = issueState(config);
  assert.equal(verifyState(config, state), true);
  assert.equal(verifyState(config, `${state}x`), false);
});

test("encrypted token store does not persist plaintext", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ghm-"));
  const file = path.join(dir, "token.enc");
  const store = new EncryptedTokenStore(file, Buffer.alloc(32, 7));
  await store.write({ access_token: "secret-access", refresh_token: "secret-refresh" });
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes("secret-access"), false);
  assert.equal((await store.read())?.refresh_token, "secret-refresh");
});

test("date validation is strict", () => {
  assert.equal(validateDate("2026-08-12", "start").toISOString().slice(0, 10), "2026-08-12");
  assert.throws(() => validateDate("2026-02-30", "start"));
});

test("Google Health v4 ranges use CivilDateTime objects", () => {
  assert.deepEqual(civilDateRange("2026-08-13", "2026-08-14"), {
    start: { date: { year: 2026, month: 8, day: 13 }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
    end: { date: { year: 2026, month: 8, day: 14 }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } }
  });
});

test("Google Health v4 reconcile filters use data-type fields", () => {
  assert.equal(dataPointFilter("sleep", "2026-08-13", "2026-08-14"), 'sleep.interval.civil_end_time >= "2026-08-13" AND sleep.interval.civil_end_time < "2026-08-14"');
  assert.equal(dataPointFilter("daily-resting-heart-rate", "2026-08-13", "2026-08-14"), 'daily_resting_heart_rate.date >= "2026-08-13" AND daily_resting_heart_rate.date < "2026-08-14"');
  assert.equal(dataPointFilter("exercise", "2026-08-13", "2026-08-14"), 'exercise.interval.civil_start_time >= "2026-08-13" AND exercise.interval.civil_start_time < "2026-08-14"');
  assert.equal(dataPointFilter("heart-rate", "2026-08-13", "2026-08-14"), 'heart_rate.sample_time.civil_time >= "2026-08-13" AND heart_rate.sample_time.civil_time < "2026-08-14"');
  assert.equal(dataPointFilter("body-fat", "2026-08-13", "2026-08-14"), 'body_fat.sample_time.civil_time >= "2026-08-13" AND body_fat.sample_time.civil_time < "2026-08-14"');
  assert.equal(dataPointFilter("steps", "2026-08-13", "2026-08-14"), 'steps.interval.civil_start_time >= "2026-08-13" AND steps.interval.civil_start_time < "2026-08-14"');
});

test("privacy redaction removes identity, tokens and location", () => {
  assert.deepEqual(redact({ name: "A", access_token: "x", nested: { latitude: 1, bpm: 60 } }), { nested: { bpm: 60 } });
});

test("OpenAPI exposes the mobile Actions endpoints with bearer auth", () => {
  const schema = openApi("https://health.example.com") as { paths: Record<string, unknown>; security: unknown[] };
  assert.ok(schema.paths["/api/summary"]);
  assert.ok(schema.paths["/api/data/{dataType}"]);
  assert.ok(schema.paths["/api/exercises"]);
  assert.deepEqual(schema.security, [{ bearerAuth: [] }]);
});

test("MCP OAuth metadata advertises DCR, PKCE and the protected resource", () => {
  const oauth = new McpOAuthServer({
    baseUrl: "https://health.example.com", setupToken: "personal-key", serviceToken: "legacy-token"
  } as never);
  assert.deepEqual(oauth.protectedResourceMetadata().authorization_servers, ["https://health.example.com"]);
  assert.equal(oauth.protectedResourceMetadata().resource, "https://health.example.com/mcp");
  assert.deepEqual(oauth.authorizationServerMetadata().code_challenge_methods_supported, ["S256"]);
  assert.equal(oauth.authorizationServerMetadata().registration_endpoint, "https://health.example.com/oauth/register");
});

test("MCP OAuth authorization code flow validates PKCE and rotates refresh tokens", async () => {
  const oauth = new McpOAuthServer({
    baseUrl: "https://health.example.com", setupToken: "personal-key", serviceToken: "legacy-token"
  } as never);
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registration = await oauth.registerClient({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
  const clientId = String(registration.client_id);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = await oauth.validateAuthorizationRequest({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state: "state",
    scope: "health.read", resource: "https://health.example.com/mcp"
  });
  const redirect = new URL(await oauth.approveAuthorization(request, "personal-key"));
  const tokens = await oauth.token({
    grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
    code: redirect.searchParams.get("code"), code_verifier: verifier
  });
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(await oauth.isAccessTokenValid(String(tokens.access_token)), true);
  const refreshed = await oauth.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  await assert.rejects(() => oauth.token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }));
});
