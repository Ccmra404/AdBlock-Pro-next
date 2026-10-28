import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const bundle = readFileSync(new URL('../rules/source-registry.tsv', import.meta.url), 'utf8');
const reward = 'https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
const updated = 'https://rules.example.org/reward.txt';
const next = bundle.replace('revision: 2026102801', 'revision: 2026102802').replace(reward, updated);

function fixture(t, { reference = 'main' } = {}) {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const state = path.join(root.dir, 'state'), agh = path.join(root.dir, 'agh'), mod = path.join(root.dir, 'module');
  mkdirSync(state); mkdirSync(path.join(agh, 'certs'), { recursive: true }); mkdirSync(path.join(mod, 'rules'), { recursive: true });
  writeFileSync(path.join(agh, 'certs/cacert.pem'), 'fixture CA');
  writeFileSync(path.join(mod, 'rules/source-registry.tsv'), bundle);
  const script = path.join(root.dir, 'scripts/source-registry.sh');
  writeFileSync(script, readFileSync(new URL('../scripts/source-registry.sh', import.meta.url), 'utf8')
    .replace('AdBlock-Pro-next/main/rules/source-registry.tsv', 'AdBlock-Pro-next/' + reference + '/rules/source-registry.tsv'));
  const remote = path.join(root.dir, 'remote'), curl = path.join(root.dir, 'curl'), calls = path.join(root.dir, 'calls');
  writeFileSync(remote, next);
  writeFileSync(curl, '#!/bin/sh\noutput= url=\nwhile [ "$#" -gt 0 ]; do case "$1" in --cacert|--connect-timeout|--max-time|--max-filesize) shift 2 ;; -o) output=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac; done\nprintf "%s\\n" "$url" >> "$CALLS"\n[ "$FAIL_DOWNLOAD" != 1 ] || exit 28\n[ "$url" != "$FAIL_URL" ] || exit 28\ncp "$REMOTE" "$output"\n');
  chmodSync(curl, 0o755);
  const env = { ...root.env('Magisk'), ABP_STATE_DIR: shellPath(state), ABP_AGH_DIR: shellPath(agh),
    ABP_MODULE_DIR: shellPath(mod), CURL: shellPath(curl), REMOTE: shellPath(remote), CALLS: shellPath(calls) };
  const run = (...args) => spawnSync(process.env.ABP_REGISTRY_TEST_SHELL || 'bash', [shellPath(script), ...args], { env, encoding: 'utf8', timeout: 10000 });
  return { run, state, remote, calls, env, cache: path.join(state, 'source-registry.tsv') };
}

test('bundled registry resolves only recognized built-in sources', t => {
  const f = fixture(t), urls = f.run('urls', reward);
  assert.equal(urls.status, 0, urls.stderr);
  assert.equal(urls.stdout.trim().split('\n')[0], reward);
  assert.notEqual(f.run('urls', 'https://my.example.org/list.txt').status, 0);
});

test('online registry advances and offline or stale responses retain the cached revision', t => {
  const f = fixture(t);
  assert.equal(f.run('refresh').status, 0);
  assert.equal(readFileSync(f.cache, 'utf8'), next);
  assert.equal(f.run('urls', reward).stdout.trim().split('\n')[0], updated);
  f.env.FAIL_DOWNLOAD = '1';
  assert.equal(f.run('refresh').status, 0);
  assert.equal(readFileSync(f.cache, 'utf8'), next);
  delete f.env.FAIL_DOWNLOAD;
  writeFileSync(f.remote, bundle);
  assert.equal(f.run('refresh').status, 0);
  assert.equal(readFileSync(f.cache, 'utf8'), next);
});

test('invalid or conflicting online registry never replaces the last valid snapshot', t => {
  const f = fixture(t);
  assert.equal(f.run('refresh').status, 0);
  for (const bad of [
    next.replace(updated, 'http://rules.example.org/reward.txt'),
    next.replace(updated, 'https://127.0.0.1/private'),
    next.replace(updated, 'https://host.local/private'),
    next.replace(updated, 'https://evil.example/a?token=secret'),
    next.replace(updated, 'https://rules.example.org/other.txt'),
    next + '10007\t' + updated + '\n',
    next + '#'.repeat(17000),
  ]) {
    writeFileSync(f.remote, bad);
    assert.equal(f.run('refresh').status, 0);
    assert.equal(readFileSync(f.cache, 'utf8'), next);
  }
});

test('an unavailable online registry falls back to the bundled snapshot', t => {
  const f = fixture(t); f.env.FAIL_DOWNLOAD = '1';
  assert.equal(f.run('refresh').status, 0);
  assert.equal(existsSync(f.cache), false);
  assert.equal(f.run('urls', reward).stdout.trim().split('\n')[0], reward);
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 4);
});

test('test builds use their own commit-scoped registry and do not reuse the production cache', t => {
  const sha = 'a'.repeat(40), f = fixture(t, { reference: sha });
  writeFileSync(f.cache, next);
  assert.equal(f.run('urls', reward).stdout.trim().split('\n')[0], reward);
  f.env.FAIL_URL='https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/' + sha + '/rules/source-registry.tsv';
  assert.equal(f.run('refresh').status, 0);
  assert.equal(readFileSync(path.join(f.state, 'source-registry-test-' + sha + '.tsv'), 'utf8'), next);
  assert.deepEqual(readFileSync(f.calls, 'utf8').trim().split('\n'), [
    'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/' + sha + '/rules/source-registry.tsv',
    'https://gcore.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@' + sha + '/rules/source-registry.tsv',
  ]);
});
