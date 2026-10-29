import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystemHarness } from "./support/system-harness.mjs";
import {
  compareProductionKeyUsage, keyUsageCutoverComparisonEnabled, validComparisonTarget,
} from "../src/worker/storage/key-usage-cutover-compare.ts";

test("P25 production comparison is disabled without explicit flag and bindings", async () => {
  assert.equal(keyUsageCutoverComparisonEnabled({}), false);
  assert.equal(keyUsageCutoverComparisonEnabled({ KEY_USAGE_CUTOVER_COMPARE: "1" }), false);
  assert.equal(keyUsageCutoverComparisonEnabled({
    KEY_USAGE_CUTOVER_COMPARE: "1", CACHE: {}, KEY_USAGE_COUNTER: {},
  }), true);
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const uuid = crypto.randomUUID();
  assert.equal(validComparisonTarget(uuid, day, now), true);
  assert.equal(validComparisonTarget(uuid, "2026-02-30", now), false);
  assert.equal(validComparisonTarget(uuid, "1999-01-01", now), false);
  assert.equal(validComparisonTarget(uuid, "2999-01-01", now), false);
  assert.equal(validComparisonTarget("bad", day, now), false);
  assert.equal(await compareProductionKeyUsage({}, uuid, day), null);
});

test("P25 manager-only KV vs DO diagnostic never changes the authoritative Key source", async t => {
  const h = await createSystemHarness("usage-prod-compare-" + crypto.randomUUID());
  t.after(() => h.close());
  const created = await (await h.request("/keys", {
    method: "POST", value: { name: "safe", scopes: ["bin:read"] },
  })).json();
  const compareEnv = { ...h.env, KEY_USAGE_CUTOVER_COMPARE: "1" };
  const shadowEnv = { ...compareEnv, KEY_USAGE_DO_SHADOW: "1" };
  const today = new Date().toISOString().slice(0, 10);
  const path = "/analytics/key-usage-compare?keyId=" + created.key.id + "&day=" + today;

  assert.equal((await h.request(path)).status, 404, "off by default");
  assert.equal((await h.request(path, {}, { ...compareEnv, KEY_USAGE_COUNTER: undefined })).status, 404);

  const call = await h.worker.fetch(new Request("https://example.test/api/v1/bins", {
    headers: { Authorization: "Bearer " + created.token },
  }), shadowEnv);
  assert.equal(call.status, 200);
  const response = await h.request(path, {}, compareEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.keyId, created.key.id);
  assert.equal(result.day, today);
  assert.equal(result.legacy.available, true);
  assert.equal(result.durable.available, true);
  assert.equal(result.durable.count, 1);
  assert.ok(result.legacy.count >= 1);
  assert.equal(result.comparable, false, "equal counters do NOT establish Queue completeness");
  assert.equal(result.safeToCutover, false);
  assert.ok(result.blockers.includes("queue_backlog_not_verified"));
  assert.ok(result.blockers.includes("historical_migration_not_implemented"));
  assert.ok(result.blockers.includes("late_event_settlement_not_implemented"));
  assert.ok(result.blockers.includes("queue_consumer_not_active"));

  const keys = (await (await h.request("/keys")).json()).items;
  assert.equal(keys[0].usageApproximate, true, "manager Key usage still uses legacy KV");
  assert.equal((await h.request(path + "&token=private", {}, compareEnv)).status, 400);
  assert.equal((await h.request(path + "&day=" + today, {}, compareEnv)).status, 400);
  assert.equal((await h.request(path.replace(today, "2026-02-30"), {}, compareEnv)).status, 400);
  const unauthorized = await h.worker.fetch(new Request("https://example.test/api/v1" + path, {
    headers: { Authorization: "Bearer " + created.token },
  }), compareEnv);
  assert.equal(unauthorized.status, 401, "Bearer API Key must never access diagnostics");
});

test("P25 source outages never produce false zeros or unsafe cutover approvals", async t => {
  const h = await createSystemHarness("usage-prod-compare-outage-" + crypto.randomUUID());
  t.after(() => h.close());
  const keyId = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10);
  const env = { ...h.env, KEY_USAGE_CUTOVER_COMPARE: "1",
    KEY_USAGE_QUEUE_SHADOW: "1", KEY_USAGE_CONSUMER_ENABLED: "1",
    KEY_USAGE_EVENTS_QUEUE: { send: async () => {} }, KEY_USAGE_DLQ_ARCHIVE: {},
  };
  const shadowDown = await compareProductionKeyUsage({
    ...env, KEY_USAGE_COUNTER: { idFromName: () => { throw Error("secret in internal error"); } },
  }, keyId, day);
  assert.equal(shadowDown.durable.available, false);
  assert.equal(shadowDown.durable.count, null);
  assert.equal(shadowDown.observedDifference, null);
  assert.equal(shadowDown.safeToCutover, false);
  assert.ok(shadowDown.blockers.includes("durable_counter_unavailable"));
  assert.doesNotMatch(JSON.stringify(shadowDown), /secret in internal error/);

  const kvDown = await compareProductionKeyUsage({
    ...env, CACHE: { get: async () => { throw Error("private token"); } },
  }, keyId, day);
  assert.equal(kvDown.legacy.available, false);
  assert.equal(kvDown.legacy.count, null);
  assert.equal(kvDown.observedDifference, null);
  assert.equal(kvDown.safeToCutover, false);
  assert.doesNotMatch(JSON.stringify(kvDown), /private token/);
});
