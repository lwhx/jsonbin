interface Env {
  DATA?: R2Bucket;
  CACHE?: KVNamespace;
  RATE_LIMITER?: DurableObjectNamespace;

  APP_ORIGIN?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TOKEN_PEPPER?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
}
