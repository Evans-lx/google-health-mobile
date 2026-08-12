import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { issueState, verifyState } from "../src/auth.js";
import { EncryptedTokenStore } from "../src/crypto-store.js";
import { redact, validateDate } from "../src/google-health.js";
import { openApi } from "../src/openapi.js";

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

test("privacy redaction removes identity, tokens and location", () => {
  assert.deepEqual(redact({ name: "A", access_token: "x", nested: { latitude: 1, bpm: 60 } }), { nested: { bpm: 60 } });
});

test("OpenAPI exposes the mobile Actions endpoints with bearer auth", () => {
  const schema = openApi("https://health.example.com") as { paths: Record<string, unknown>; security: unknown[] };
  assert.ok(schema.paths["/api/summary"]);
  assert.ok(schema.paths["/api/data/{dataType}"]);
  assert.deepEqual(schema.security, [{ bearerAuth: [] }]);
});
