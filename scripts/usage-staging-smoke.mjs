#!/usr/bin/env node
/**
 * P24b live staging acceptance smoke. Never sends to the production Worker.
 *
 * Default: read-only configuration validation (no network, no credentials).
 * Explicit --run: sends two identical *synthetic* events through the guarded
 * staging-only HTTP producer and verifies exactly one SQLite DO increment.
 *
 * Requires STAGING_URL and STAGING_PROBE_TOKEN. Optional Cloudflare Access:
 * CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET. Never print these secrets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const CONFIG = "wrangler.usage-staging.jsonc";
const MODE = process.argv.slice(2);
const running = MODE.length === 1 && MODE[0] === "--run";
const checking = MODE.length === 0 || (MODE.length === 1 && MODE[0] === "--check");
if (!running && !checking) {
  console.error("Usage: node scripts/usage-staging-smoke.mjs [--check|--run]");
  process.exit(2);
}

function configCheck() {
  const staging = JSON.parse(readFileSync(CONFIG, "utf8"));
  const prod = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  assert.equal(staging.name, "jsonbin-usage-staging");
  assert.equal(staging.main, "src/worker/usage-staging-entry.ts");
  assert.notEqual(staging.name, prod.name);
  assert.equal(staging.vars.KEY_USAGE_STAGING_MODE, "0");
  assert.equal(staging.vars.KEY_USAGE_QUEUE_SHADOW, "0");
  assert.equal(staging.vars.KEY_USAGE_CONSUMER_ENABLED, "0");
  assert.equal(staging.vars.KEY_USAGE_DO_SHADOW, "0");
  assert.ok(!("STAGING_PROBE_TOKEN" in staging.vars));
  assert.equal(staging.kv_namespaces, undefined);
  assert.equal(staging.assets, undefined);
  assert.equal(staging.triggers, undefined);
  assert.equal(staging.routes, undefined);
  assert.equal(staging.route, undefined);
  assert.deepEqual(staging.r2_buckets.map(x => x.binding), ["KEY_USAGE_DLQ_ARCHIVE"]);
  assert.deepEqual(staging.durable_objects.bindings.map(x => x.name), ["KEY_USAGE_COUNTER"]);
  assert.deepEqual(staging.queues.producers.map(x => x.queue), ["jsonbin-key-usage-events-staging"]);
  assert.deepEqual(staging.queues.consumers.map(x => x.queue), [
    "jsonbin-key-usage-events-staging", "jsonbin-key-usage-dlq-staging",
  ]);
  assert.equal(staging.queues.consumers[0].dead_letter_queue, "jsonbin-key-usage-dlq-staging");
  assert.equal(staging.queues.consumers[1].dead_letter_queue, "jsonbin-key-usage-quarantine-staging");
  assert.equal(prod.queues, undefined);
  console.log("P24b staging configuration isolation verified; no remote changes.");
}

async function live() {
  const urlValue = process.env.STAGING_URL;
  const token = process.env.STAGING_PROBE_TOKEN;
  if (!urlValue || !token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("missing_or_invalid_staging_access");
  }
  const root = new URL(urlValue);
  if (root.protocol !== "https:" ||
      !/^jsonbin-usage-staging\.[a-z0-9-]+\.workers\.dev$/.test(root.hostname) ||
      root.pathname !== "/" || root.search || root.hash ||
      root.username || root.password || root.port) {
    throw new Error("unsafe_staging_url");
  }

  const headers = { Authorization: "Bearer " + token };
  const accessId = process.env.CF_ACCESS_CLIENT_ID;
  const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (Boolean(accessId) !== Boolean(accessSecret)) {
    throw new Error("incomplete_cloudflare_access");
  }
  if (accessId && accessSecret) {
    headers["CF-Access-Client-Id"] = accessId;
    headers["CF-Access-Client-Secret"] = accessSecret;
  }

  async function call(path, init) {
    const response = await fetch(new URL(path, root), {
      method: init?.method ?? "GET",
      headers: { ...headers, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("staging_redirect_refused");
    }
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  const state = await call("/__staging/usage/status");
  if (state.status !== 200) throw new Error("staging_status_unavailable");
  const ready = state.body;
  if (ready?.staging !== true || !ready?.producerEnabled || !ready?.consumerEnabled ||
      !ready?.queueBound || !ready?.doBound || !ready?.archiveBound) {
    throw new Error("staging_bindings_or_feature_flags_not_ready");
  }
  // Synthetic UUID with no relationship to any real user or API Key.
  const keyId = randomUUID(), eventId = randomUUID(), timestamp = new Date().toISOString();
  const day = timestamp.slice(0, 10);
  const dayPath = "/__staging/usage/day?keyId=" + encodeURIComponent(keyId) +
    "&day=" + encodeURIComponent(day);
  const initial = await call(dayPath);
  if (initial.status !== 200 || initial.body?.count !== 0) {
    throw new Error("synthetic_counter_not_isolated");
  }
  const message = JSON.stringify({ version: 1, keyId, eventId, timestamp });
  const first = await call("/__staging/usage/emit", { method: "POST", body: message });
  if (first.status !== 202 || first.body?.queued !== true) {
    throw new Error("staging_queue_send_failed");
  }

  async function poll(expected, attempts) {
    for (let i = 0; i < attempts; i++) {
      const item = await call(dayPath);
      if (item.status === 200 && item.body?.count === expected) return;
      if (item.status !== 200 || item.body?.count > expected) {
        throw new Error("staging_counter_mismatch");
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error("staging_consumption_not_confirmed");
  }

  await poll(1, 45);
  const second = await call("/__staging/usage/emit", { method: "POST", body: message });
  if (second.status !== 202 || second.body?.queued !== true) {
    throw new Error("staging_duplicate_send_failed");
  }
  // Wait beyond the 2s configured consumer batch timeout to see duplicate ACK.
  await new Promise(resolve => setTimeout(resolve, 6_000));
  await poll(1, 5);
  console.log("PASS: Staging Queue consumed two identical synthetic events; SQLite count stayed 1.");
}

try {
  configCheck();
  if (running) await live();
} catch (error) {
  // Never log exception messages from network/providers: may include secrets.
  const code = error instanceof Error && [
    "missing_or_invalid_staging_access", "unsafe_staging_url", "incomplete_cloudflare_access",
    "staging_redirect_refused", "staging_status_unavailable",
    "staging_bindings_or_feature_flags_not_ready", "synthetic_counter_not_isolated",
    "staging_queue_send_failed", "staging_consumption_not_confirmed",
    "staging_counter_mismatch", "staging_duplicate_send_failed",
  ].includes(error.message) ? error.message : "staging_validation_failed";
  console.error("P24b staging smoke failed:", code);
  process.exitCode = 1;
}
