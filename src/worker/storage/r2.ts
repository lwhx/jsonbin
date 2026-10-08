export function requireDataBucket(env: Env): R2Bucket {
  if (!env.DATA) {
    throw new Error("R2 binding DATA is not configured");
  }

  return env.DATA;
}

export async function getJson<T>(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (!object) return null;

  return {
    value: (await object.json()) as T,
    etag: object.httpEtag,
    uploaded: object.uploaded,
  };
}

export async function putJson(
  bucket: R2Bucket,
  key: string,
  value: unknown,
  options?: R2PutOptions,
) {
  return bucket.put(key, JSON.stringify(value, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    ...options,
  });
}

/** Enumerate logical resource folders, not immutable nested version files.
 * R2 delimiter grouping keeps LIST cost independent of version history size.
 * The canonical meta.json remains the only source of returned data.
 */
export async function listJsonObjects<T>(bucket: R2Bucket, prefix: string) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    const metaKeys = [
      ...page.objects.filter(object => object.key.endsWith("/meta.json")).map(object => object.key),
      ...page.delimitedPrefixes.map(group => `${group.endsWith("/") ? group : group + "/"}meta.json`),
    ];
    // Bounded fan-out: an account with many Bins must not open 1000 R2 GETs at once.
    for (let i = 0; i < metaKeys.length; i += 16) {
      const records = await Promise.all(metaKeys.slice(i, i + 16)
        .map(key => getJson<T>(bucket, key)));
      for (const record of records) if (record) items.push(record.value);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return items;
}
