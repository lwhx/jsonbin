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
