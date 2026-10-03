import {
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run hash-password -- \"your password\"");
  process.exit(1);
}

const iterations = 210_000;
const salt = randomBytes(24);
const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");

const b64url = (value) =>
  value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

console.log(
  [
    "pbkdf2-sha256",
    iterations,
    b64url(salt),
    b64url(digest),
  ].join("$"),
);
