import { assertBytes, MAX_BACKUP_BYTES, MAX_VALUE_BYTES, validateBackup, validateBusinessValue } from '../../../shared/backup.ts';
import type { BackupPackage } from '../../../shared/backup-types.ts';
import { SystemError } from '../../../shared/system.ts';
import { decodeBackupZip, MAX_ZIP_BYTES } from '../../../shared/zip.ts';
export type ImportPreviewItem = { fileName: string; name: string; value: unknown; type: string; bytes: number };
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
function parse(bytes: Uint8Array): unknown { try { return JSON.parse(decoder.decode(bytes)); } catch { throw new SystemError(422, 'invalid_json'); } }
export async function parseStandardFiles(files: readonly File[]): Promise<ImportPreviewItem[]> {
  if (!files.length || files.length > 100) throw new SystemError(422, 'validation_failed');
  if (files.some(f => f.size > MAX_VALUE_BYTES) || files.reduce((n, f) => n + f.size, 0) > MAX_BACKUP_BYTES) throw new SystemError(413, 'payload_too_large');
  const result: ImportPreviewItem[] = []; let total = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer()); total += bytes.length;
    if (bytes.length > MAX_VALUE_BYTES || total > MAX_BACKUP_BYTES) throw new SystemError(413, 'payload_too_large');
    const value = parse(bytes); validateBusinessValue(value); assertBytes(value, MAX_VALUE_BYTES);
    const name = file.name.replace(/\.[^.]*$/, '').trim().slice(0, 160) || '导入 JSON';
    result.push({ fileName: file.name, name, value, type: value === null ? '空值' : Array.isArray(value) ? '数组' : typeof value === 'object' ? '对象' : typeof value === 'boolean' ? '布尔' : typeof value === 'number' ? '数字' : '字符串', bytes: bytes.length });
  }
  assertBytes({ items: result.map(({ name, value }) => ({ name, value })) }); return result;
}
export async function readBackupFile(file: File): Promise<BackupPackage> {
  if (file.size > MAX_ZIP_BYTES) throw new SystemError(413, 'payload_too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_ZIP_BYTES) throw new SystemError(413, 'payload_too_large');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return decodeBackupZip(bytes);
  if (bytes.length > MAX_BACKUP_BYTES) throw new SystemError(413, 'payload_too_large');
  return validateBackup(parse(bytes));
}
