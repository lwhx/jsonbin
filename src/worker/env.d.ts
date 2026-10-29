interface Env {
  DATA?: R2Bucket;
  CACHE?: KVNamespace;
  RATE_LIMITER?: DurableObjectNamespace;
  KEY_USAGE_COUNTER?: DurableObjectNamespace;
  KEY_USAGE_DO_SHADOW?: string;
  KEY_USAGE_QUEUE_SHADOW?: string;
  KEY_USAGE_CONSUMER_ENABLED?: string;
  KEY_USAGE_EVENTS_QUEUE?: Queue<import('./storage/key-usage-queue').QueuedKeyUsageEvent>;
  KEY_USAGE_DLQ_ARCHIVE?: R2Bucket;

  APP_ORIGIN?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TOKEN_PEPPER?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
}
