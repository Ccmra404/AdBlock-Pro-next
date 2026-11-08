import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';

const source = readFileSync(new URL('../post-fs-data.sh', import.meta.url), 'utf8');

function runHook(t, helperBody) {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-state-boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'adblockpro');
  const helper = path.join(dataDir, 'bin/adblock-bootstrap');
  mkdirSync(path.dirname(helper), { recursive: true });
  if (helperBody !== undefined) {
    writeFileSync(helper, helperBody);
    chmodSync(helper, 0o755);
  }
  const script = path.join(dir, 'post-fs-data.sh');
  writeFileSync(script, source.replaceAll('/data/adb/adblockpro', shellPath(dataDir)));
  const result = spawnSync('bash', [shellPath(script)], { encoding: 'utf8', timeout: 10000 });
  return { result, history: path.join(dataDir, 'history.log'), helper };
}

test('missing migration helper does not block boot', t => {
  const { result, history } = runHook(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(existsSync(history), false);
});

test('migration failure is logged and does not block boot', t => {
  const { result, history } = runHook(t, '#!/bin/sh\necho "migration fixture failure" >&2\nexit 9\n');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(readFileSync(history, 'utf8'), /State directory migration notice: migration fixture failure/);
});

test('boot invokes the migration helper with the fixed command', t => {
  const { result, history, helper } = runHook(t,
    '#!/bin/sh\nprintf "%s\\n" "$1" > "${0}.called"\n');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(helper + '.called', 'utf8'), 'migrate-state\n');
  assert.equal(existsSync(history), false);
});
