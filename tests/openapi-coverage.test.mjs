import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../dist/jsonbin/index.js';

// Fetch the spec exactly as clients do, from the built Worker.
async function fetchSpec() {
  const response = await app.fetch(new Request('https://tests.local/api/v1/openapi.json'), {});
  assert.equal(response.status, 200);
  return response.json();
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

function registeredOperations() {
  const operations = new Set();
  for (const route of app.routes) {
    const method = String(route.method).toLowerCase();
    if (!HTTP_METHODS.has(method)) continue; // skip ALL (middleware)
    if (!route.path.startsWith('/api/v1')) continue;
    let path = route.path.slice('/api/v1'.length) || '/';
    path = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/\*$/, '/{path}');
    operations.add(`${method} ${path}`);
  }
  return operations;
}

function specOperations(spec) {
  const operations = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) operations.add(`${method} ${path}`);
    }
  }
  return operations;
}

test('every registered /api/v1 route is documented in the OpenAPI spec', async () => {
  const spec = await fetchSpec();
  const registered = registeredOperations();
  const documented = specOperations(spec);

  const missing = [...registered].filter(op => !documented.has(op)).sort();
  assert.deepEqual(missing, [], 'routes missing from OpenAPI spec');

  const stale = [...documented].filter(op => !registered.has(op)).sort();
  assert.deepEqual(stale, [], 'spec operations without a runtime route');
});

test('spec passes structural validation: operations declare responses and known security schemes', async () => {
  const spec = await fetchSpec();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.info.title && spec.info.version);
  assert.ok(Object.keys(spec.paths).length >= 40, 'spec must cover the full API surface');

  const schemes = new Set(Object.keys(spec.components.securitySchemes));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `${method} ${path} must declare responses`);
      assert.ok(operation.summary, `${method} ${path} must declare a summary`);
      const security = operation.security ?? spec.security;
      assert.ok(Array.isArray(security), `${method} ${path} must resolve a security requirement`);
      for (const requirement of security) {
        for (const name of Object.keys(requirement)) {
          assert.ok(schemes.has(name), `${method} ${path} references unknown scheme ${name}`);
        }
      }
    }
  }

  // Anonymous endpoints must explicitly opt out; session-only must not accept Bearer.
  assert.deepEqual(spec.paths['/system/health'].get.security, []);
  assert.deepEqual(spec.paths['/bins/{id}'].get.security, []);
  assert.deepEqual(spec.paths['/bins/{id}/save-as-template'].post.security, [{ CookieAuth: [] }]);
  assert.deepEqual(spec.paths['/system/settings'].get.security, [{ CookieAuth: [] }]);
  assert.deepEqual(spec.paths['/bins'].post.security, [{ CookieAuth: [] }, { BearerAuth: [] }]);
});
