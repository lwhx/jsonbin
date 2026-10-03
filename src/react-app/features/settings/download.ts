export function downloadBytes(bytes: Uint8Array, fileName: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: contentType }));
  const link = document.createElement('a'); link.href = url; link.download = fileName;
  try { document.body.append(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}
