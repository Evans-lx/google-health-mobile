import type { Config } from "./config.js";
import { EncryptedTokenStore, type GoogleToken } from "./crypto-store.js";

const API_BASE = "https://health.googleapis.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALLOWED_DATA_TYPES = new Set([
  "steps", "distance", "active-energy-burned", "total-calories", "active-minutes",
  "heart-rate", "daily-resting-heart-rate", "daily-heart-rate-variability",
  "sleep", "exercise", "weight", "body-fat", "oxygen-saturation", "respiratory-rate"
]);

const SESSION_DATA_TYPES = new Set(["sleep", "exercise"]);
const SAMPLE_DATA_TYPES = new Set([
  "heart-rate", "weight", "body-fat", "oxygen-saturation", "respiratory-rate"
]);

export class GoogleHealthClient {
  readonly store: EncryptedTokenStore;
  constructor(private readonly config: Config) {
    this.store = new EncryptedTokenStore(config.tokenFile, config.encryptionKey, config.databaseUrl);
  }

  authorizationUrl(state: string): string {
    const query = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scopes.join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state
    });
    return `${AUTH_URL}?${query}`;
  }

  async exchangeCode(code: string): Promise<void> {
    const token = await this.tokenRequest(new URLSearchParams({
      client_id: this.config.googleClientId,
      client_secret: this.config.googleClientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      code
    }));
    await this.store.write(token);
  }

  async status() {
    const token = await this.store.read();
    return {
      connected: Boolean(token?.refresh_token || token?.access_token),
      scopes: token?.scope?.split(" ").filter(Boolean) ?? [],
      expires_at: token?.expires_at ? new Date(token.expires_at * 1000).toISOString() : null
    };
  }

  async query(dataType: string, start: string, end: string, aggregate = true): Promise<unknown> {
    if (!ALLOWED_DATA_TYPES.has(dataType)) throw new Error(`Unsupported data type: ${dataType}`);
    const startDate = validateDate(start, "start");
    const endDate = validateDate(end, "end");
    if (endDate < startDate) throw new Error("end must not be before start");
    const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    if (days > 90) throw new Error("Date range cannot exceed 90 days");

    if (aggregate && !SESSION_DATA_TYPES.has(dataType)) {
      return this.request("POST", `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:dailyRollUp`, {
        range: civilDateRange(start, nextDay(end)),
        windowSizeDays: 1,
        pageSize: Math.min(days, 90),
        dataSourceFamily: "users/me/dataSourceFamilies/all-sources"
      });
    }
    return this.reconcile(dataType, dataPointFilter(dataType, start, nextDay(end)));
  }

  async summary(start: string, end: string): Promise<Record<string, unknown>> {
    const types = ["steps", "distance", "active-energy-burned", "sleep", "daily-resting-heart-rate", "weight", "body-fat"];
    const settled = await Promise.allSettled(types.map((type) => this.query(type, start, end, type !== "sleep" && !type.startsWith("daily-"))));
    return {
      period: { start, end },
      disclaimer: "Google Health API beta data. This is not medical advice.",
      data: Object.fromEntries(settled.map((result, index) => [types[index], result.status === "fulfilled" ? redact(result.value) : { unavailable: true, reason: safeError(result.reason) }]))
    };
  }

  async exercises(start: string, end: string): Promise<Record<string, unknown>> {
    return {
      period: { start, end },
      disclaimer: "Exercise sessions are returned only when a source such as Fitbit recorded them as workouts.",
      data: await this.query("exercise", start, end, false)
    };
  }

  async disconnect(): Promise<void> { await this.store.clear(); }

  private async reconcile(dataType: string, filter: string): Promise<Record<string, unknown>> {
    const dataPoints: unknown[] = [];
    let pageToken: string | undefined;

    do {
      const params: Record<string, string> = {
        filter,
        pageSize: SESSION_DATA_TYPES.has(dataType) ? "25" : "10000"
      };
      if (SESSION_DATA_TYPES.has(dataType)) {
        params.dataSourceFamily = "users/me/dataSourceFamilies/google-wearables";
      }
      if (pageToken) params.pageToken = pageToken;

      const suffix = new URLSearchParams(params);
      const page = await this.request(
        "GET",
        `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints:reconcile?${suffix}`
      ) as { dataPoints?: unknown[]; nextPageToken?: unknown };
      if (Array.isArray(page.dataPoints)) dataPoints.push(...page.dataPoints);
      pageToken = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : undefined;
    } while (pageToken);

    return { dataPoints };
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let token = await this.validToken();
    let response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 401 && token.refresh_token) {
      token = await this.refresh(token);
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
    }
    const text = await response.text();
    const value = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`Google Health API ${response.status}: ${JSON.stringify(value).slice(0, 600)}`);
    return redact(value);
  }

  private async validToken(): Promise<GoogleToken> {
    const token = await this.store.read();
    if (!token?.access_token) throw new Error("Google Health is not connected. Open /connect first.");
    if (token.refresh_token && (!token.expires_at || token.expires_at - Math.floor(Date.now() / 1000) < 300)) return this.refresh(token);
    return token;
  }

  private async refresh(previous: GoogleToken): Promise<GoogleToken> {
    if (!previous.refresh_token) throw new Error("Refresh token is missing; reconnect Google Health.");
    const refreshed = await this.tokenRequest(new URLSearchParams({
      client_id: this.config.googleClientId,
      client_secret: this.config.googleClientSecret,
      grant_type: "refresh_token",
      refresh_token: previous.refresh_token
    }));
    const merged = { ...previous, ...refreshed, refresh_token: refreshed.refresh_token ?? previous.refresh_token };
    await this.store.write(merged);
    return merged;
  }

  private async tokenRequest(body: URLSearchParams): Promise<GoogleToken> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok || typeof value.access_token !== "string") throw new Error(`Google OAuth ${response.status}: ${JSON.stringify(value).slice(0, 400)}`);
    return {
      access_token: value.access_token,
      refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
      token_type: typeof value.token_type === "string" ? value.token_type : undefined,
      scope: typeof value.scope === "string" ? value.scope : undefined,
      expires_at: typeof value.expires_in === "number" ? Math.floor(Date.now() / 1000) + value.expires_in : undefined
    };
  }
}

export function validateDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} is invalid`);
  return date;
}

function nextDay(value: string): string {
  const date = validateDate(value, "end");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function civilDateRange(start: string, end: string) {
  return { start: civilDateTime(start), end: civilDateTime(end) };
}

function civilDateTime(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return {
    date: { year, month, day },
    time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 }
  };
}

export function dataPointFilter(dataType: string, start: string, endExclusive: string): string {
  const snake = dataType.replace(/-/g, "_");
  if (dataType === "sleep") {
    return `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${endExclusive}"`;
  }
  if (dataType === "exercise") {
    return `exercise.interval.civil_start_time >= "${start}" AND exercise.interval.civil_start_time < "${endExclusive}"`;
  }
  if (dataType.startsWith("daily-")) {
    return `${snake}.date >= "${start}" AND ${snake}.date < "${endExclusive}"`;
  }
  if (SAMPLE_DATA_TYPES.has(dataType)) {
    return `${snake}.sample_time.civil_time >= "${start}" AND ${snake}.sample_time.civil_time < "${endExclusive}"`;
  }
  return `${snake}.interval.civil_start_time >= "${start}" AND ${snake}.interval.civil_start_time < "${endExclusive}"`;
}

const SENSITIVE_KEYS = /^(access.?token|refresh.?token|authorization|email|name|display.?name|avatar|latitude|longitude|coordinates|route|gps)$/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEYS.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/(access_token|refresh_token|client_secret)[^,}]*/gi, "$1=[redacted]").slice(0, 300);
}
