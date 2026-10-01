import { readFileSync } from 'node:fs';

export const DEFAULT_CONFIG_PATH = './config.json';

// Environment variables that always win over config-file values (secret
// material should never live in the committed config file).
export const ENV_SECRETS = {
  PAPERLESS_TOKEN: 'paperless.token',
  ACTUAL_PASSWORD: 'actual.password',
  ACTUAL_SYNC_ID: 'actual.budgetSyncId',
};

// Required fields; token/password/syncId may come from env.
const REQUIRED_FIELDS = [
  'paperless.baseUrl',
  'paperless.token',
  'actual.serverUrl',
  'actual.password',
  'actual.budgetSyncId',
  'actual.defaultAccountName',
];

const ENV_HINT = {
  'paperless.token': 'PAPERLESS_TOKEN',
  'actual.password': 'ACTUAL_PASSWORD',
  'actual.budgetSyncId': 'ACTUAL_SYNC_ID',
};

// Values like "${PAPERLESS_TOKEN}" mean "fill me from the environment".
const PLACEHOLDER_RE = /^\$\{[A-Z_]+\}$/;

function getAtPath(obj, path) {
  let node = obj;
  for (const key of path.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function setAtPath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
}

function isMissing(value) {
  return (
    value == null ||
    value === '' ||
    (typeof value === 'string' && PLACEHOLDER_RE.test(value.trim()))
  );
}

/**
 * Reads the bridge config (AB2PB_CONFIG or `configPath`, default ./config.json),
 * overlays env secrets (PAPERLESS_TOKEN / ACTUAL_PASSWORD / ACTUAL_SYNC_ID), and
 * validates required fields, throwing an Error naming the missing field.
 *
 * Returns the README-friendly resolved config object.
 */
export function loadConfig({ configPath, env = process.env } = {}) {
  const path = configPath ?? env.AB2PB_CONFIG ?? DEFAULT_CONFIG_PATH;

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config file "${path}": ${err.message}`);
  }

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config file "${path}" must contain a JSON object`);
  }

  const resolved = structuredClone(raw);

  // Env secrets win over config-file values (inline or placeholder).
  for (const [envKey, jsonPath] of Object.entries(ENV_SECRETS)) {
    const envValue = env[envKey];
    if (envValue !== undefined && envValue !== '') {
      setAtPath(resolved, jsonPath, envValue);
    }
  }

  // Fail fast, naming the exact missing field.
  for (const field of REQUIRED_FIELDS) {
    if (isMissing(getAtPath(resolved, field))) {
      const via = ENV_HINT[field]
        ? ` (set ${ENV_HINT[field]} env var or a value in the config file)`
        : '';
      throw new Error(`Missing required config: ${field}${via} [config: ${path}]`);
    }
  }

  if (
    resolved.signals == null ||
    typeof resolved.signals !== 'object' ||
    Array.isArray(resolved.signals)
  ) {
    throw new Error(`Missing required config: signals [config: ${path}]`);
  }

  return resolved;
}