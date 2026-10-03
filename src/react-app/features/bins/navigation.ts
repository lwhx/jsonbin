export function binHash(id: string) { return `#/bins/${encodeURIComponent(id)}`; }
export function binIdFromHash(hash: string): string | null {
  const match = /^#\/bins\/([^/]+)$/.exec(hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
