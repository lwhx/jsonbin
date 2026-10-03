import {
  base64UrlDecode,
  base64UrlEncode,
  timingSafeEqualBase64Url,
} from "../lib/crypto";

const encoder = new TextEncoder();

type ParsedPasswordHash = {
  iterations: number;
  salt: Uint8Array;
  expected: string;
};

function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const [algorithm, iterationsRaw, saltRaw, expected] = value.split("$");
  if (algorithm !== "pbkdf2-sha256") return null;

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 100_000) return null;
  if (!saltRaw || !expected) return null;

  return {
    iterations,
    salt: base64UrlDecode(saltRaw),
    expected,
  };
}

export async function verifyPassword(
  password: string,
  encodedHash: string | undefined,
) {
  if (!encodedHash) return false;

  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: parsed.iterations,
      salt: parsed.salt,
    },
    key,
    256,
  );

  return timingSafeEqualBase64Url(
    base64UrlEncode(derived),
    parsed.expected,
  );
}
