import path from "node:path";

const scopes = [
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly"
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function publicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PUBLIC_URL must use HTTPS outside localhost");
  }
  return url.toString().replace(/\/$/, "");
}

export type Config = ReturnType<typeof getConfig>;

export function getConfig() {
  const encryptionKey = Buffer.from(required("TOKEN_ENCRYPTION_KEY"), "hex");
  if (encryptionKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters");
  const baseUrl = publicUrl(required("PUBLIC_URL"));
  return {
    port: Number(process.env.PORT ?? 3000),
    baseUrl,
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    serviceToken: required("SERVICE_TOKEN"),
    setupToken: required("SETUP_TOKEN"),
    encryptionKey,
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    tokenFile: path.join(process.env.DATA_DIR ?? "./data", "google-token.enc"),
    redirectUri: `${baseUrl}/oauth/google/callback`,
    scopes
  };
}
