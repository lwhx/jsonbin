interface Env {
  DATA?: R2Bucket;
  CACHE?: KVNamespace;
  /** Workers native Rate Limiting API (per-PoP approximate 120/min). */
  JSONBIN_KEY_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  /** Workers native Rate Limiting API (per-PoP approximate 240/min). */
  JSONBIN_ANON_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> };

  APP_ORIGIN?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TOKEN_PEPPER?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
}
