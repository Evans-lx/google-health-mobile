import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { issueState, verifyState } from "../src/auth.js";
import { EncryptedTokenStore } from "../src/crypto-store.js";
import { civilDateRange, dataPointFilter, redact, validateDate } from "../src/google-health.js";
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
