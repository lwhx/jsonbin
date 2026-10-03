import { z } from 'zod';
import { MAX_BACKUP_BYTES, sha256, validateBackup } from './backup.ts';
import type { BackupPackage } from './backup-types.ts';
import { SystemError } from './system.ts';
export const MAX_ZIP_BYTES = MAX_BACKUP_BYTES + 65536;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const names = ['manifest.json', 'backup.json'];
function bad(): never { throw new SystemError(422, 'invalid_backup_zip'); }
const crcTable = Array.from({ length: 256 }, (_, value) => { let n = value; for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export async function encodeBackupZip(input: BackupPackage): Promise<Uint8Array> {
  const backup = encoder.encode(JSON.stringify(validateBackup(input)));
  const manifest = encoder.encode(JSON.stringify({ format: 'jsonbin-backup-zip', schemaVersion: 1, file: 'backup.json', bytes: backup.length, sha256: await sha256(backup) }));
  const files = [manifest, backup];
  const localSize = files.reduce((n, bytes, i) => n + 30 + names[i].length + bytes.length, 0);
  const centralSize = names.reduce((n, name) => n + 46 + name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22), view = new DataView(output.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true), u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  let local = 0, central = localSize;
  for (let i = 0; i < files.length; i++) {
    const bytes = files[i], name = encoder.encode(names[i]), crc = crc32(bytes);
    u32(local, 0x04034b50); u16(local + 4, 20); u16(local + 6, 0x800); u32(local + 14, crc); u32(local + 18, bytes.length); u32(local + 22, bytes.length); u16(local + 26, name.length);
    output.set(name, local + 30); output.set(bytes, local + 30 + name.length);
    u32(central, 0x02014b50); u16(central + 4, 20); u16(central + 6, 20); u16(central + 8, 0x800); u32(central + 16, crc); u32(central + 20, bytes.length); u32(central + 24, bytes.length); u16(central + 28, name.length); u32(central + 42, local);
    output.set(name, central + 46); central += 46 + name.length; local += 30 + name.length + bytes.length;
  }
  u32(central, 0x06054b50); u16(central + 8, 2); u16(central + 10, 2); u32(central + 12, centralSize); u32(central + 16, localSize);
  return output;
}
export async function decodeBackupZip(bytes: Uint8Array): Promise<BackupPackage> {
  if (bytes.length > MAX_ZIP_BYTES) throw new SystemError(413, 'payload_too_large');
  try {
    if (bytes.length < 22) bad();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o: number) => view.getUint16(o, true), u32 = (o: number) => view.getUint32(o, true);
    const end = bytes.length - 22;
    if (u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== 2 || u16(end + 10) !== 2 || u16(end + 20)) bad();
    const start = u32(end + 16), size = u32(end + 12);
    if (start + size !== end) bad();
    const files = new Map<string, Uint8Array>(); let central = start, expectedLocal = 0;
    for (let i = 0; i < 2; i++) {
      if (central + 46 > end || u32(central) !== 0x02014b50 || u16(central + 6) > 20 || ![0, 0x800].includes(u16(central + 8)) || u16(central + 10) || u16(central + 30) || u16(central + 32) || u16(central + 34)) bad();
      const length = u32(central + 24), nameLength = u16(central + 28), offset = u32(central + 42), crc = u32(central + 16);
      if (length > MAX_BACKUP_BYTES || length !== u32(central + 20) || central + 46 + nameLength > end || offset !== expectedLocal || offset + 30 > start) bad();
      const name = decoder.decode(bytes.subarray(central + 46, central + 46 + nameLength));
      if (!names.includes(name) || files.has(name)) bad();
      if (u32(offset) !== 0x04034b50 || u16(offset + 4) !== u16(central + 6) || u16(offset + 6) !== u16(central + 8) || u16(offset + 8) || u16(offset + 10) !== u16(central + 12) || u16(offset + 12) !== u16(central + 14) || u32(offset + 14) !== crc || u32(offset + 18) !== length || u32(offset + 22) !== length || u16(offset + 26) !== nameLength || u16(offset + 28)) bad();
      const dataStart = offset + 30 + nameLength, dataEnd = dataStart + length;
      if (dataEnd > start || decoder.decode(bytes.subarray(offset + 30, dataStart)) !== name) bad();
      const file = bytes.subarray(dataStart, dataEnd); if (crc32(file) !== crc) bad(); files.set(name, file);
      expectedLocal = dataEnd; central += 46 + nameLength;
    }
    if (central !== end || expectedLocal !== start) bad();
    const manifestBytes = files.get('manifest.json')!, backup = files.get('backup.json')!;
    if (manifestBytes.length > 4096) bad();
    const manifest = z.object({ format: z.literal('jsonbin-backup-zip'), schemaVersion: z.literal(1), file: z.literal('backup.json'), bytes: z.number().int().nonnegative().max(MAX_BACKUP_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(JSON.parse(decoder.decode(manifestBytes)));
    if (!manifest.success || manifest.data.bytes !== backup.length || manifest.data.sha256 !== await sha256(backup)) bad();
    return validateBackup(JSON.parse(decoder.decode(backup)));
  } catch (error) { if (error instanceof SystemError) throw error; return bad(); }
}
