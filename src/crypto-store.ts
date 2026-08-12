import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

export type GoogleToken = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  token_type?: string;
};

export class EncryptedTokenStore {
  private readonly pool?: Pool;
  private initialized?: Promise<void>;

  constructor(private readonly file: string, private readonly key: Buffer, databaseUrl?: string) {
    if (databaseUrl) this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async exists(): Promise<boolean> {
    if (this.pool) return (await this.read()) !== null;
    try { await fs.access(this.file); return true; } catch { return false; }
  }

  async read(): Promise<GoogleToken | null> {
    if (this.pool) {
      await this.ensureTable();
      const result = await this.pool.query<{ envelope: Record<string, string> }>("SELECT envelope FROM oauth_tokens WHERE id = $1", ["google-health-personal"]);
      if (!result.rows[0]) return null;
      return this.decrypt(result.rows[0].envelope);
    }
    try {
      const envelope = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, string>;
      return this.decrypt(envelope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(token: GoogleToken): Promise<void> {
    const envelope = this.encrypt(token);
    if (this.pool) {
      await this.ensureTable();
      await this.pool.query(
        "INSERT INTO oauth_tokens (id, envelope, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = now()",
        ["google-health-personal", JSON.stringify(envelope)]
      );
      return;
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    if (this.pool) {
      await this.ensureTable();
      await this.pool.query("DELETE FROM oauth_tokens WHERE id = $1", ["google-health-personal"]);
      return;
    }
    await fs.unlink(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private encrypt(token: GoogleToken): Record<string, string | number> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  private decrypt(envelope: Record<string, string>): GoogleToken {
    const iv = Buffer.from(envelope.iv, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as GoogleToken;
  }

  private ensureTable(): Promise<void> {
    if (!this.pool) return Promise.resolve();
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS oauth_tokens (
      id text PRIMARY KEY,
      envelope jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => undefined);
    return this.initialized;
  }
}
