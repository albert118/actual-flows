import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Stage 5 CLI routing: spawn the real entry point so --reconcile and unknown
// flags are exercised exactly as a user would run them. --reconcile must not
// require config.json or network (it is a v2 stub), so these run in a fresh
// checkout with no fixtures.

// --- AC22 -------------------------------------------------------------------

test('AC22: --reconcile routes to the report stub and exits cleanly', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, '--reconcile'], {
    encoding: 'utf8',
  });

  assert.match(stdout, /reconcile report not yet implemented \(v2\)/);
  assert.equal(stderr, '', 'stub logs to stdout only');
});

test('cli: unknown flags print usage and exit 0', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, '--frobnicate'], {
    encoding: 'utf8',
  });

  assert.match(stdout, /^ab2pb - Actual <-> Paperless bridge/);
  assert.match(stdout, /--reconcile/, 'usage lists the --reconcile flag');
  assert.equal(stderr, '');
});