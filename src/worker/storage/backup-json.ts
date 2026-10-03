import { MAX_BACKUP_BYTES } from '../../shared/backup.ts';
import { SystemError } from '../../shared/system.ts';

// Older writes use two-space indentation. Bound the compact JSON rather than
// allocating that whitespace, while retaining every byte inside JSON strings.
export async function readBackupJson(object: R2ObjectBody, maxBytes = MAX_BACKUP_BYTES): Promise<unknown> {
  const maxStoredBytes = maxBytes * (2 * 64 + 8) + 65536;
  if (object.size > maxStoredBytes) throw new SystemError(413, 'payload_too_large');
  const reader = object.body.getReader(), parts: Uint8Array[] = [];
  let block = new Uint8Array(8192), used = 0, compactBytes = 0, storedBytes = 0;
  let quoted = false, escaped = false, whitespace = false;
  let previous: number | undefined;
  const punctuation = (byte: number) => byte === 123 || byte === 125 || byte === 91 || byte === 93 || byte === 44 || byte === 58;
  function append(byte: number) {
    if (++compactBytes > maxBytes) throw new SystemError(413, 'payload_too_large');
    block[used++] = byte;
    if (used === block.length) { parts.push(block); block = new Uint8Array(8192); used = 0; }
  }
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      storedBytes += value.length;
      if (storedBytes > maxStoredBytes) throw new SystemError(413, 'payload_too_large');
      for (const byte of value) {
        if (!quoted && (byte === 32 || byte === 9 || byte === 10 || byte === 13)) { whitespace = true; continue; }
        // Keep token separation: malformed `f alse` must not become valid false.
        if (whitespace && previous !== undefined && !punctuation(previous) && !punctuation(byte)) append(32);
        whitespace = false;
        append(byte);
        previous = byte;
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) quoted = false;
        } else if (byte === 34) quoted = true;
      }
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(compactBytes); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  bytes.set(block.subarray(0, used), offset);
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true, ignoreBOM:false}).decode(bytes)); }
  catch { throw new SystemError(409, 'backup_unavailable'); }
}
