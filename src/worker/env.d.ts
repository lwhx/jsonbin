interface Env {
  DATA?: R2Bucket;
  CACHE?: KVNamespace;
  RATE_LIMITER?: DurableObjectNamespace;
  KEY_USAGE_COUNTER?: DurableObjectNamespace;
  KEY_USAGE_DO_SHADOW?: string;

  APP_ORIGIN?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TOKEN_PEPPER?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
}
