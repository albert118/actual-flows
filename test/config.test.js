import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

// Base config that satisfies every required field via env placeholders.
const baseConfig = {
  paperless: {
    baseUrl: 'http://paperless:8000',
    token: '${PAPERLESS_TOKEN}',
    apiVersion: 10,
    fields: {
      imported: 'actual_transaction_id',
      status: 'actual_status',
      amount: 'actual_amount',
      date: 'actual_date',
      payee: 'actual_payee',
      currency: 'actual_currency',
    },
  },
  actual: {
    serverUrl: 'http://actual-server:5006',
    password: '${ACTUAL_PASSWORD}',
    budgetSyncId: '${ACTUAL_SYNC_ID}',
    dataDir: '/data',
    defaultAccountName: 'Cash',
  },
  signals: { tags: ['invoice'], documentTypes: [], correspondents: [] },
  locale: { currency: 'AUD', timezone: 'Australia/Sydney', dateFormats: ['d/m/y'] },
};

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      mergeDeep(target[key], value);
    } else {
      // Assigning undefined makes JSON.stringify drop the key on write.
      target[key] = value;
    }
  }
  return target;
}

let tmpDir;
function writeConfig(overrides = {}) {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'ab2pb-config-'));
  const cfg = mergeDeep(structuredClone(baseConfig), overrides);
  const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(cfg));
  return configPath;
}

after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('AC1: rejects config with no PAPERLESS_TOKEN env and no token value', () => {
  const configPath = writeConfig(); // token is an unfilled placeholder
  assert.throws(() => loadConfig({ configPath, env: {} }), /paperless\.token/);
});

test('AC1b: rejects config with token key absent and no env secret', () => {
  const configPath = writeConfig({ paperless: { token: undefined } });
  assert.throws(() => loadConfig({ configPath, env: {} }), /paperless\.token/);
});

test('AC2: rejects config missing ACTUAL_SYNC_ID', () => {
  // Other secrets are supplied so validation reaches budgetSyncId.
  const configPath = writeConfig({ actual: { budgetSyncId: undefined } });
  assert.throws(
    () => loadConfig({ configPath, env: { PAPERLESS_TOKEN: 't', ACTUAL_PASSWORD: 'p' } }),
    /actual\.budgetSyncId/,
  );
});

test('AC2b: rejects config with unfilled sync id placeholder and no env secret', () => {
  const configPath = writeConfig(); // budgetSyncId is an unfilled placeholder
  assert.throws(
    () => loadConfig({ configPath, env: { PAPERLESS_TOKEN: 't', ACTUAL_PASSWORD: 'p' } }),
    /actual\.budgetSyncId/,
  );
});

test('AC3: env secrets win over inline config file values', () => {
  const configPath = writeConfig({
    paperless: { token: 'file-token' },
    actual: { password: 'file-password', budgetSyncId: 'file-sync-id' },
  });
  const config = loadConfig({
    configPath,
    env: {
      PAPERLESS_TOKEN: 'env-token',
      ACTUAL_PASSWORD: 'env-password',
      ACTUAL_SYNC_ID: 'env-sync-id',
    },
  });
  assert.equal(config.paperless.token, 'env-token');
  assert.equal(config.actual.password, 'env-password');
  assert.equal(config.actual.budgetSyncId, 'env-sync-id');
});

test('AC3b: env secrets fill config file placeholders', () => {
  const configPath = writeConfig(); // placeholders for all three secrets
  const config = loadConfig({
    configPath,
    env: {
      PAPERLESS_TOKEN: 'env-token',
      ACTUAL_PASSWORD: 'env-password',
      ACTUAL_SYNC_ID: 'env-sync-id',
    },
  });
  assert.equal(config.paperless.token, 'env-token');
  assert.equal(config.actual.password, 'env-password');
  assert.equal(config.actual.budgetSyncId, 'env-sync-id');
});

test('non-secret fields survive resolution unchanged', () => {
  const configPath = writeConfig({
    paperless: { token: 'some-token' },
    actual: { password: 'some-password', budgetSyncId: 'some-sync-id' },
  });
  const config = loadConfig({ configPath, env: {} });
  assert.equal(config.paperless.baseUrl, 'http://paperless:8000');
  assert.equal(config.actual.serverUrl, 'http://actual-server:5006');
  assert.equal(config.actual.defaultAccountName, 'Cash');
  assert.deepEqual(config.signals.tags, ['invoice']);
  assert.equal(config.locale.currency, 'AUD');
});