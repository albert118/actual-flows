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

// The three signal lists that accept either plain names or {name, account}.
export const SIGNAL_LIST_KEYS = ['tags', 'documentTypes', 'correspondents'];

// Default duplicate-guard window: look back/forward this many days around the
// parsed date for a possibly-matching existing Actual transaction.
export const DEFAULT_DUPLICATE_WINDOW_DAYS = 7;

/**
 * Validates one `signals.*` entry and returns its stable normalised form.
 *
 * A plain string is kept as-is (back-compat: such entries map to the default
 * account). A `{name, account}` object is returned as a clean two-key object —
 * `name` must be a non-empty string and `account`, when present, a non-empty
 * string. Anything else throws a clear error naming the exact list + index.
 *
 * @param {unknown} entry
 * @param {string} key        list name, e.g. 'tags'
 * @param {number} index      position within the list
 * @param {string} configPath origin config file, for the error message
 */
export function normaliseSignalEntry(entry, key, index, configPath) {
  if (typeof entry === 'string') return entry;

  if (entry != null && typeof entry === 'object' && !Array.isArray(entry)) {
    const { name, account } = entry;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(
        `Invalid config: signals.${key}[${index}].name must be a non-empty string [config: ${configPath}]`,
      );
    }
    if (account !== undefined && (typeof account !== 'string' || account.trim() === '')) {
      throw new Error(
        `Invalid config: signals.${key}[${index}].account must be a non-empty string when set [config: ${configPath}]`,
      );
    }
    return account !== undefined ? { name, account } : { name };
  }

  throw new Error(
    `Invalid config: signals.${key}[${index}] must be a string or {name, account} [config: ${configPath}]`,
  );
}

/** The signal name of an entry (plain string or {name, account}). */
export function signalEntryName(entry) {
  return typeof entry === 'string' ? entry : entry?.name;
}

/** The mapped account of an entry; undefined for plain strings. */
export function signalEntryAccount(entry) {
  return typeof entry === 'string' ? undefined : entry?.account;
}

/**
 * Reads the bridge config (ACTUAL_FLOWS_CONFIG or `configPath`, default ./config.json),
 * overlays env secrets (PAPERLESS_TOKEN / ACTUAL_PASSWORD / ACTUAL_SYNC_ID), and
 * validates required fields, throwing an Error naming the missing field.
 *
 * Returns the README-friendly resolved config object.
 */
export function loadConfig({ configPath, env = process.env } = {}) {
  const path = configPath ?? env.ACTUAL_FLOWS_CONFIG ?? DEFAULT_CONFIG_PATH;

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

  // Normalise signal entries into the stable string | {name, account} shape,
  // preserving config order; invalid entries fail fast with a clear error.
  for (const key of SIGNAL_LIST_KEYS) {
    const list = resolved.signals[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(`Invalid config: signals.${key} must be an array [config: ${path}]`);
    }
    resolved.signals[key] = list.map((entry, index) =>
      normaliseSignalEntry(entry, key, index, path),
    );
  }

  // incomeSignals is OPTIONAL: absent means "no income signals" (documents
  // parse as expense unless content keywords match). When present it must be
  // an object whose documentTypes/tags are arrays of non-empty-string names
  // (kept verbatim — resolved to Paperless ids later by the bridge). Unlike
  // `signals`, entries are plain names only, no {name, account} objects.
  if (resolved.incomeSignals === undefined) {
    resolved.incomeSignals = { documentTypes: [], tags: [] };
  } else if (
    resolved.incomeSignals == null ||
    typeof resolved.incomeSignals !== 'object' ||
    Array.isArray(resolved.incomeSignals)
  ) {
    throw new Error(`Invalid config: incomeSignals must be an object [config: ${path}]`);
  } else {
    for (const key of ['documentTypes', 'tags']) {
      const list = resolved.incomeSignals[key];
      if (list === undefined) {
        resolved.incomeSignals[key] = [];
        continue;
      }
      if (!Array.isArray(list)) {
        throw new Error(`Invalid config: incomeSignals.${key} must be an array [config: ${path}]`);
      }
      resolved.incomeSignals[key] = list.map((entry, index) => {
        if (typeof entry !== 'string' || entry.trim() === '') {
          throw new Error(
            `Invalid config: incomeSignals.${key}[${index}] must be a non-empty string [config: ${path}]`,
          );
        }
        return entry;
      });
    }
  }

  // duplicateGuard is OPTIONAL and defaults to DISABLED (v1-compatible: docs
  // import unconditionally once parsed). When enabled, a parsed doc whose
  // amount/date/payee matches an existing Actual transaction in the window is
  // tagged possible-duplicate instead of imported. `enabled` must be a
  // boolean; `windowDays` (how far before/after the parsed date to look,
  // default 7) must be a positive integer.
  if (resolved.duplicateGuard === undefined) {
    resolved.duplicateGuard = { enabled: false, windowDays: DEFAULT_DUPLICATE_WINDOW_DAYS };
  } else if (
    resolved.duplicateGuard == null ||
    typeof resolved.duplicateGuard !== 'object' ||
    Array.isArray(resolved.duplicateGuard)
  ) {
    throw new Error(`Invalid config: duplicateGuard must be an object [config: ${path}]`);
  } else {
    const { enabled, windowDays } = resolved.duplicateGuard;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error(`Invalid config: duplicateGuard.enabled must be a boolean [config: ${path}]`);
    }
    if (windowDays !== undefined && (!Number.isInteger(windowDays) || windowDays < 1)) {
      throw new Error(
        `Invalid config: duplicateGuard.windowDays must be a positive integer [config: ${path}]`,
      );
    }
    if (enabled === undefined) resolved.duplicateGuard.enabled = false;
    if (windowDays === undefined) resolved.duplicateGuard.windowDays = DEFAULT_DUPLICATE_WINDOW_DAYS;
  }

  return resolved;
}
