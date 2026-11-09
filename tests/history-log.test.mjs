import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { rootFixture, shellPath } from './shell-fixture.mjs';

const historyLogger = fileURLToPath(new URL('../scripts/history-log.sh', import.meta.url));

function append(t, fixture, log, mode, payload) {
  fixture.addBusybox('Magisk');
  const result = spawnSync('bash', ['-c', '. "$1" || exit 1; abp_append_history "$2" "$3" "$4"',
    'history-log-test', shellPath(fixture.compatFile), shellPath(log), mode, payload], {
    encoding: 'utf8', env: { ...fixture.env('Magisk'), ABP_HISTORY_LOG_SCRIPT: shellPath(historyLogger) }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test('history append supports lines and completed output files', t => {
  const fixture = rootFixture(t);
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-history-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'history.log');
  const output = path.join(dir, 'update-output');
  writeFileSync(output, 'download completed\n');

  append(t, fixture, log, 'line', 'boot ready');
  append(t, fixture, log, 'file', shellPath(output));

  assert.equal(readFileSync(log, 'utf8'), 'boot ready\ndownload completed\n');
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('oversized history keeps the newest complete lines within bounded files', t => {
  const fixture = rootFixture(t);
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-history-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'history.log');
  const record = '旧的历史条目-' + 'x'.repeat(180) + '\n';
  writeFileSync(log, record.repeat(7000));

  append(t, fixture, log, 'line', 'latest-entry-日志');

  const current = readFileSync(log, 'utf8');
  const archive = readFileSync(log + '.1', 'utf8');
  assert.match(current, /latest-entry-日志\n$/);
  assert.match(archive, /旧的历史条目/);
  assert(current.startsWith('旧的历史条目-') || current.startsWith('latest-entry-'));
  assert(archive.startsWith('旧的历史条目-'));
  assert.doesNotMatch(current, /\uFFFD/);
  assert.doesNotMatch(archive, /\uFFFD/);
  assert(statSync(log).size <= 524288);
  assert(statSync(log + '.1').size <= 524288);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(statSync(log + '.1').mode & 0o777, 0o600);
  assert.equal(existsSync(log + '.rotate-window.tmp'), false);
});

test('invalid history append mode leaves the log untouched', t => {
  const fixture = rootFixture(t);
  fixture.addBusybox('Magisk');
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-history-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'history.log');
  const result = spawnSync('bash', ['-c', '. "$1" || exit 1; abp_append_history "$2" invalid value',
    'history-log-test', shellPath(fixture.compatFile), shellPath(log)], {
    encoding: 'utf8', env: { ...fixture.env('Magisk'), ABP_HISTORY_LOG_SCRIPT: shellPath(historyLogger) }, timeout: 10000,
  });
  assert.equal(result.status, 2);
  assert.equal(existsSync(log), false);
});
