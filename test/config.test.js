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
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'actual-flows-config-'));
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

// --- Stage 2: per-signal account mapping (normalisation + validation) -------

const SECRET_ENV = { PAPERLESS_TOKEN: 't', ACTUAL_PASSWORD: 'p', ACTUAL_SYNC_ID: 's' };

test('Stage2: object entries are normalised in place, plain strings preserved, order kept', () => {
  const configPath = writeConfig({
    signals: {
      tags: ['invoice', { name: 'bill', account: 'Amex' }, { name: 'receipt' }],
      documentTypes: [{ name: 'statement', account: 'Bank' }, 'credit-note'],
      correspondents: [],
    },
  });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.signals.tags, [
    'invoice',
    { name: 'bill', account: 'Amex' },
    { name: 'receipt' },
  ]);
  assert.deepEqual(config.signals.documentTypes, [
    { name: 'statement', account: 'Bank' },
    'credit-note',
  ]);
  assert.deepEqual(config.signals.correspondents, []);
});

test('Stage2: object entry without account is valid and normalised to {name}', () => {
  const configPath = writeConfig({
    signals: { tags: [{ name: 'bill' }], documentTypes: [], correspondents: [] },
  });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.signals.tags, [{ name: 'bill' }]);
});

test('Stage2: extra keys on an object entry are dropped in normalisation', () => {
  const configPath = writeConfig({
    signals: { tags: [{ name: 'bill', account: 'Amex', junk: 'x' }], documentTypes: [], correspondents: [] },
  });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.signals.tags, [{ name: 'bill', account: 'Amex' }]);
});

test('Stage2: non-string/non-object entry throws a clear error', () => {
  const configPath = writeConfig({
    signals: { tags: ['invoice', 42], documentTypes: [], correspondents: [] },
  });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /signals\.tags\[1\]/);
});

test('Stage2: object entry with non-empty-but-blank name throws', () => {
  const configPath = writeConfig({
    signals: { tags: [{ name: '   ' }], documentTypes: [], correspondents: [] },
  });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /signals\.tags\[0\]\.name/);
});

test('Stage2: object entry with blank account throws', () => {
  const configPath = writeConfig({
    signals: { tags: [{ name: 'bill', account: '   ' }], documentTypes: [], correspondents: [] },
  });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /signals\.tags\[0\]\.account/);
});

test('Stage2: non-array signals list throws a clear error', () => {
  const configPath = writeConfig({
    signals: { tags: 'invoice', documentTypes: [], correspondents: [] },
  });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /signals\.tags must be an array/);
});

// --- Stage 3: incomeSignals -------------------------------------------------

test('Stage3: incomeSignals absent defaults to empty lists', () => {
  const configPath = writeConfig(); // no incomeSignals key in the base config
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.incomeSignals, { documentTypes: [], tags: [] });
});

test('Stage3: valid income signal names are preserved verbatim', () => {
  const configPath = writeConfig({
    incomeSignals: { documentTypes: ['credit note', 'dividend-statement'], tags: ['dividend'] },
  });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.incomeSignals, {
    documentTypes: ['credit note', 'dividend-statement'],
    tags: ['dividend'],
  });
});

test('Stage3: missing incomeSignals sub-key defaults to an empty array', () => {
  const configPath = writeConfig({ incomeSignals: { tags: ['dividend'] } });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.incomeSignals, { documentTypes: [], tags: ['dividend'] });
});

test('Stage3: non-object incomeSignals throws a clear error', () => {
  const configPath = writeConfig({ incomeSignals: 'dividend' });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /incomeSignals must be an object/);
});

test('Stage3: non-array incomeSignals list throws a clear error', () => {
  const configPath = writeConfig({ incomeSignals: { documentTypes: 'credit note', tags: [] } });
  assert.throws(
    () => loadConfig({ configPath, env: SECRET_ENV }),
    /incomeSignals\.documentTypes must be an array/,
  );
});

test('Stage3: non-string incomeSignals entry throws a clear error', () => {
  const configPath = writeConfig({
    incomeSignals: { documentTypes: ['credit note', 42], tags: [] },
  });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /incomeSignals\.documentTypes\[1\]/);
});

test('Stage3: blank incomeSignals entry throws a clear error', () => {
  const configPath = writeConfig({ incomeSignals: { documentTypes: [], tags: ['   '] } });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /incomeSignals\.tags\[0\]/);
});

test('Stage3: incomeSignals accepts plain names only — object entries are rejected', () => {
  const configPath = writeConfig({
    incomeSignals: { documentTypes: [], tags: [{ name: 'dividend' }] },
  });
  assert.throws(() => loadConfig({ configPath, env: SECRET_ENV }), /incomeSignals\.tags\[0\]/);
});

// --- Tier A item 4: duplicateGuard ------------------------------------------

test('TierA4: duplicateGuard absent defaults to disabled with the default window', () => {
  const configPath = writeConfig(); // no duplicateGuard key in the base config
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.duplicateGuard, { enabled: false, windowDays: 7 });
});

test('TierA4: duplicateGuard without windowDays defaults the window', () => {
  const configPath = writeConfig({ duplicateGuard: { enabled: true } });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.duplicateGuard, { enabled: true, windowDays: 7 });
});

test('TierA4: duplicateGuard keeps an explicit window', () => {
  const configPath = writeConfig({ duplicateGuard: { enabled: true, windowDays: 3 } });
  const config = loadConfig({ configPath, env: SECRET_ENV });
  assert.deepEqual(config.duplicateGuard, { enabled: true, windowDays: 3 });
});

test('TierA4: non-object duplicateGuard throws a clear error', () => {
  const configPath = writeConfig({ duplicateGuard: 'yes' });
  assert.throws(
    () => loadConfig({ configPath, env: SECRET_ENV }),
    /duplicateGuard must be an object/,
  );
});

test('TierA4: non-boolean duplicateGuard.enabled throws a clear error', () => {
  const configPath = writeConfig({ duplicateGuard: { enabled: 'yes' } });
  assert.throws(
    () => loadConfig({ configPath, env: SECRET_ENV }),
    /duplicateGuard\.enabled must be a boolean/,
  );
});

test('TierA4: invalid duplicateGuard.windowDays throws a clear error', () => {
  for (const windowDays of [0, -1, 1.5, '7']) {
    const configPath = writeConfig({ duplicateGuard: { enabled: true, windowDays } });
    assert.throws(
      () => loadConfig({ configPath, env: SECRET_ENV }),
      /duplicateGuard\.windowDays must be a positive integer/,
    );
  }
});