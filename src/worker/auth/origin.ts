/** One policy for browser CORS and writes using ambient session cookies. */
export function applicationOrigin(request: Request, env: Env): string | null {
  if (!env.APP_ORIGIN) return new URL(request.url).origin;
  try {
    const url = new URL(env.APP_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== env.APP_ORIGIN) return null;
    return url.origin;
  } catch { return null; }
}

export function allowedRequestOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  // Non-browser clients authenticate separately and need not send Origin.
  return origin === null || origin === applicationOrigin(request, env);
}
