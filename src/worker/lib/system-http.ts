import { requireSession } from '../middleware/auth';
import { SystemError } from '../../shared/system.ts';
export const managementSession: typeof requireSession = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.raw.headers.has('Authorization')) return c.json({ error: 'session_required' }, 401);
  return requireSession(c, next);
};
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SystemError(400, 'invalid_json');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new SystemError(413, 'payload_too_large'); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) { if (error instanceof SystemError) throw error; throw new SystemError(400, 'invalid_json'); }
  finally { reader.releaseLock(); }
}
