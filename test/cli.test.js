import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Stage 1 CLI routing: spawn the real entry point so --reconcile and unknown
// flags are exercised exactly as a user would run them. --reconcile now
// requires config + network (read-only), so in a fresh checkout with no
// config.json it must report the config error on stderr and exit 1 (not hang).

// --- AC22 -------------------------------------------------------------------

test('AC22: --reconcile requires config: reports the config error and exits 1', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [CLI, '--reconcile'], { encoding: 'utf8' }),
    (err) => {
      assert.equal(err.code, 1, 'exit code 1 on missing config');
      assert.match(err.stderr, /ab2pb: Cannot read config file/);
      assert.doesNotMatch(err.stderr, /not yet implemented/, 'stub behaviour is gone');
      return true;
    },
  );
});

test('cli: unknown flags print usage and exit 0', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, '--frobnicate'], {
    encoding: 'utf8',
  });

  assert.match(stdout, /^ab2pb - Actual <-> Paperless bridge/);
  assert.match(stdout, /--reconcile/, 'usage lists the --reconcile flag');
  assert.equal(stderr, '');
});