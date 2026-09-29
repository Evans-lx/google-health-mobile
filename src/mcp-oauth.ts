import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Pool } from "pg";
import type { Config } from "./config.js";
import { constantTimeEqual } from "./auth.js";

const SCOPE = "health.read";
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;

type ClientRecord = { clientId: string; redirectUris: string[]; clientName?: string };
type CodeRecord = {
  codeHash: string; clientId: string; redirectUri: string; codeChallenge: string;
  resource: string; scope: string; expiresAt: number;
};
type TokenRecord = { tokenHash: string; clientId: string; scope: string; resource: string; expiresAt: number };

export class McpOAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly pool?: Pool;
  private initialized?: Promise<void>;
  private readonly clients = new Map<string, ClientRecord>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();

  constructor(private readonly config: Config) {
    this.issuer = config.baseUrl;
    this.resource = `${config.baseUrl}/mcp`;
    if (config.databaseUrl) this.pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${this.config.baseUrl}/privacy`,
      resource_policy_uri: `${this.config.baseUrl}/privacy`,
      resource_tos_uri: `${this.config.baseUrl}/terms`
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.config.baseUrl}/oauth/authorize`,
      token_endpoint: `${this.config.baseUrl}/oauth/token`,
      registration_endpoint: `${this.config.baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
      resource_indicators_supported: true
    };
  }

  async registerClient(body: unknown): Promise<Record<string, unknown>> {
    const input = object(body);
    const redirectUris = stringArray(input.redirect_uris);
    if (redirectUris.length < 1 || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
      throw oauthError("invalid_redirect_uri", "redirect_uris must contain 1-10 HTTPS or localhost URLs", 400);
    }
    if (input.token_endpoint_auth_method != null && input.token_endpoint_auth_method !== "none") {
      throw oauthError("invalid_client_metadata", "Only token_endpoint_auth_method=none is supported", 400);
    }
    const clientId = randomToken(24);
    const client: ClientRecord = {
      clientId,
      redirectUris,
      clientName: typeof input.client_name === "string" ? input.client_name.slice(0, 120) : undefined
    };
    await this.saveClient(client);
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  async validateAuthorizationRequest(query: Record<string, unknown>): Promise<AuthorizationRequest> {
    const value: AuthorizationRequest = {
      responseType: stringValue(query.response_type),
      clientId: stringValue(query.client_id),
      redirectUri: stringValue(query.redirect_uri),
      codeChallenge: stringValue(query.code_challenge),
      codeChallengeMethod: stringValue(query.code_challenge_method),
      state: stringValue(query.state),
      scope: stringValue(query.scope) || SCOPE,
      resource: stringValue(query.resource) || this.resource
    };
    const client = await this.getClient(value.clientId);
    if (!client) throw oauthError("invalid_client", "Unknown OAuth client", 400);
    if (!client.redirectUris.includes(value.redirectUri)) throw oauthError("invalid_request", "redirect_uri is not registered", 400);
    if (value.responseType !== "code") throw oauthError("unsupported_response_type", "Only response_type=code is supported", 400);
    if (!value.codeChallenge || value.codeChallengeMethod !== "S256") throw oauthError("invalid_request", "PKCE S256 is required", 400);
    if (value.scope.split(/\s+/).some((scope) => scope !== SCOPE)) throw oauthError("invalid_scope", `Only ${SCOPE} is supported`, 400);
    if (value.resource !== this.resource) throw oauthError("invalid_target", "Invalid resource", 400);
    return value;
  }

  async approveAuthorization(request: AuthorizationRequest, personalKey: string): Promise<string> {
    if (!constantTimeEqual(personalKey, this.config.setupToken)) throw oauthError("access_denied", "Invalid personal connection key", 403);
    const code = randomToken(32);
    await this.saveCode({
      codeHash: hash(code), clientId: request.clientId, redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge, resource: request.resource, scope: request.scope,
      expiresAt: Date.now() + CODE_SECONDS * 1000
    });
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    if (request.state) redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", this.issuer);
    return redirect.toString();
  }

  async token(body: unknown): Promise<Record<string, unknown>> {
    const input = object(body);
    const grantType = stringValue(input.grant_type);
    if (grantType === "authorization_code") return this.exchangeAuthorizationCode(input);
    if (grantType === "refresh_token") return this.exchangeRefreshToken(input);
    throw oauthError("unsupported_grant_type", "Supported grants: authorization_code, refresh_token", 400);
  }

  async isAccessTokenValid(token: string): Promise<boolean> {
    if (!token) return false;
    const tokenHash = hash(token);
    if (this.pool) {
      await this.ensureTables();
      const result = await this.pool.query("SELECT 1 FROM mcp_oauth_tokens WHERE token_hash=$1 AND token_type='access' AND expires_at > now()", [tokenHash]);
      return result.rowCount === 1;
    }
    const record = this.accessTokens.get(tokenHash);
    return Boolean(record && record.expiresAt > Date.now() && record.resource === this.resource);
  }

  challenge(): string {
    return `Bearer resource_metadata="${this.config.baseUrl}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;
  }

  requireMcpToken() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        const validLegacyToken = token.length > 0 && constantTimeEqual(token, this.config.serviceToken);
        if (!validLegacyToken && !(await this.isAccessTokenValid(token))) {
          res.setHeader("WWW-Authenticate", this.challenge());
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        next();
      } catch (error) { next(error); }
    };
  }

  private async exchangeAuthorizationCode(input: Record<string, unknown>) {
    const code = stringValue(input.code);
    const clientId = stringValue(input.client_id);
    const redirectUri = stringValue(input.redirect_uri);
    const verifier = stringValue(input.code_verifier);
    if (!code || !clientId || !redirectUri || !verifier) throw oauthError("invalid_request", "code, client_id, redirect_uri and code_verifier are required", 400);
    const record = await this.consumeCode(hash(code));
    if (!record || record.expiresAt <= Date.now()) throw oauthError("invalid_grant", "Authorization code is invalid or expired", 400);
    if (record.clientId !== clientId || record.redirectUri !== redirectUri) throw oauthError("invalid_grant", "Authorization code does not match this client", 400);
    const actualChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (!constantTimeEqual(actualChallenge, record.codeChallenge)) throw oauthError("invalid_grant", "PKCE verification failed", 400);
    return this.issueTokenPair(record.clientId, record.scope, record.resource);
  }

  private async exchangeRefreshToken(input: Record<string, unknown>) {
    const refreshToken = stringValue(input.refresh_token);
    const clientId = stringValue(input.client_id);
    if (!refreshToken || !clientId) throw oauthError("invalid_request", "refresh_token and client_id are required", 400);
    const record = await this.consumeRefreshToken(hash(refreshToken));
    if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId) throw oauthError("invalid_grant", "Refresh token is invalid or expired", 400);
    return this.issueTokenPair(record.clientId, record.scope, record.resource);
  }

  private async issueTokenPair(clientId: string, scope: string, resource: string) {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(40);
    const now = Date.now();
    await this.saveTokens([
      { tokenHash: hash(accessToken), clientId, scope, resource, expiresAt: now + ACCESS_TOKEN_SECONDS * 1000, tokenType: "access" },
      { tokenHash: hash(refreshToken), clientId, scope, resource, expiresAt: now + REFRESH_TOKEN_SECONDS * 1000, tokenType: "refresh" }
    ]);
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope, resource };
  }

  private async saveClient(client: ClientRecord) {
    if (!this.pool) { this.clients.set(client.clientId, client); return; }
    await this.ensureTables();
    await this.pool.query("INSERT INTO mcp_oauth_clients (client_id, redirect_uris, client_name) VALUES ($1, $2::jsonb, $3)", [client.clientId, JSON.stringify(client.redirectUris), client.clientName ?? null]);
  }

  private async getClient(clientId: string): Promise<ClientRecord | null> {
    if (!this.pool) return this.clients.get(clientId) ?? null;
    await this.ensureTables();
    const result = await this.pool.query<{ client_id: string; redirect_uris: string[]; client_name: string | null }>("SELECT client_id, redirect_uris, client_name FROM mcp_oauth_clients WHERE client_id=$1", [clientId]);
    const row = result.rows[0];
    return row ? { clientId: row.client_id, redirectUris: row.redirect_uris, clientName: row.client_name ?? undefined } : null;
  }

  private async saveCode(record: CodeRecord) {
    if (!this.pool) { this.codes.set(record.codeHash, record); return; }
    await this.ensureTables();
    await this.pool.query("INSERT INTO mcp_oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7))", [record.codeHash, record.clientId, record.redirectUri, record.codeChallenge, record.resource, record.scope, record.expiresAt / 1000]);
  }

  private async consumeCode(codeHash: string): Promise<CodeRecord | null> {
    if (!this.pool) { const record = this.codes.get(codeHash) ?? null; this.codes.delete(codeHash); return record; }
    await this.ensureTables();
    const result = await this.pool.query<{ client_id: string; redirect_uri: string; code_challenge: string; resource: string; scope: string; expires_at: Date }>("DELETE FROM mcp_oauth_codes WHERE code_hash=$1 RETURNING client_id, redirect_uri, code_challenge, resource, scope, expires_at", [codeHash]);
    const row = result.rows[0];
    return row ? { codeHash, clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, resource: row.resource, scope: row.scope, expiresAt: row.expires_at.getTime() } : null;
  }

  private async saveTokens(records: Array<TokenRecord & { tokenType: "access" | "refresh" }>) {
    if (!this.pool) {
      for (const record of records) (record.tokenType === "access" ? this.accessTokens : this.refreshTokens).set(record.tokenHash, record);
      return;
    }
    await this.ensureTables();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) await client.query("INSERT INTO mcp_oauth_tokens (token_hash, token_type, client_id, scope, resource, expires_at) VALUES ($1,$2,$3,$4,$5,to_timestamp($6))", [record.tokenHash, record.tokenType, record.clientId, record.scope, record.resource, record.expiresAt / 1000]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async consumeRefreshToken(tokenHash: string): Promise<TokenRecord | null> {
    if (!this.pool) { const record = this.refreshTokens.get(tokenHash) ?? null; this.refreshTokens.delete(tokenHash); return record; }
    await this.ensureTables();
    const result = await this.pool.query<{ client_id: string; scope: string; resource: string; expires_at: Date }>("DELETE FROM mcp_oauth_tokens WHERE token_hash=$1 AND token_type='refresh' RETURNING client_id, scope, resource, expires_at", [tokenHash]);
    const row = result.rows[0];
    return row ? { tokenHash, clientId: row.client_id, scope: row.scope, resource: row.resource, expiresAt: row.expires_at.getTime() } : null;
  }

  private ensureTables(): Promise<void> {
    if (!this.pool) return Promise.resolve();
    this.initialized ??= initializeTables(this.pool);
    return this.initialized;
  }
}

type AuthorizationRequest = {
  responseType: string; clientId: string; redirectUri: string; codeChallenge: string;
  codeChallengeMethod: string; state: string; scope: string; resource: string;
};

type OAuthError = Error & { oauthCode: string; status: number };
export function oauthError(code: string, description: string, status = 400): OAuthError {
  return Object.assign(new Error(description), { oauthCode: code, status });
}
export function isOAuthError(error: unknown): error is OAuthError {
  return error instanceof Error && "oauthCode" in error && "status" in error;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw oauthError("invalid_request", "Expected a JSON object or form body", 400);
  return value as Record<string, unknown>;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }
function validRedirectUri(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)); }
  catch { return false; }
}
function randomToken(bytes: number): string { return crypto.randomBytes(bytes).toString("base64url"); }
function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

async function initializeTables(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
    client_id text PRIMARY KEY, redirect_uris jsonb NOT NULL, client_name text, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
    code_hash text PRIMARY KEY, client_id text NOT NULL, redirect_uri text NOT NULL, code_challenge text NOT NULL,
    resource text NOT NULL, scope text NOT NULL, expires_at timestamptz NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    token_hash text PRIMARY KEY, token_type text NOT NULL CHECK (token_type IN ('access','refresh')),
    client_id text NOT NULL, scope text NOT NULL, resource text NOT NULL, expires_at timestamptz NOT NULL
  )`);
  await pool.query("DELETE FROM mcp_oauth_codes WHERE expires_at <= now()");
  await pool.query("DELETE FROM mcp_oauth_tokens WHERE expires_at <= now()");
}
