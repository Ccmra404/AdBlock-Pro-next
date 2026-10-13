import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t, status = 'VmRSS: 2300 kB\n', rollup = 'Rss: 32768 kB\nPss: 25484 kB\n') {
  const root = rootFixture(t);
  const agh = path.join(root.dir, 'runtime'), state = path.join(root.dir, 'state'), proc = path.join(root.dir, 'proc');
  for (const dir of [path.join(agh, 'bin'), state, path.join(proc, '1234')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(agh, 'bin/agh.pid'), '1234\n');
  const processDir = path.join(proc, '1234');
  writeFileSync(path.join(processDir, 'cmdline'), shellPath(path.join(agh, 'bin/AdGuardHome')) + '\0-c\0');
  writeFileSync(path.join(processDir, 'stat'), '1234 (AdGuardHome) S ' + Array(18).fill('0').join(' ') + ' 12345\n');
  writeFileSync(path.join(processDir, 'status'), status);
  writeFileSync(path.join(processDir, 'smaps_rollup'), rollup);
  const env = { ...root.env(), ABP_AGH_DIR: shellPath(agh), ABP_STATE_DIR: shellPath(state), ABP_PROC_DIR: shellPath(proc) };
  const launcher = path.join(root.dir, 'memory-test.sh');
  writeFileSync(launcher, '[ -z "$ABP_MEMORY_TEST_BIN" ] || export PATH="$ABP_MEMORY_TEST_BIN:$PATH"\nexec bash "$@"\n');
  function run(mode, pid = '1234') {
    const result = spawnSync('bash', [shellPath(launcher), shellPath(path.resolve('scripts/memory.sh')), mode, pid], { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
  }
  return { root, agh, state, processDir, env, run };
}

test('explicit sample uses Rss and Pss from the same rollup, not Android VmRSS', t => {
  const f = fixture(t, 'VmRSS: 0 kB\n');
  const result = f.run('sample');
  assert.equal(result.mem_rss_kb, '32768');
  assert.equal(result.mem_pss_kb, '25484');
  assert.equal(result.mem_source, 'smaps_rollup');
  assert.equal(result.mem_pid, '1234');
  assert(Number(result.mem_sampled_at) > 0);
});

for (const status of ['VmRSS: 0 kB\n', 'Name: AdGuardHome\n', 'VmRSS: nope kB\n', 'VmRSS: 100 MB\n']) {
  test('quick poll does not fabricate RAM for ' + status.trim(), t => {
    const f = fixture(t, status);
    assert.equal(f.run('quick').mem_rss_kb, 'unavailable');
    assert.equal(f.run('quick').mem_pss_kb, 'unavailable');
  });
}

test('quick polling reuses a labelled sample without rescanning rollup, and rejects PID reuse', t => {
  const f = fixture(t);
  f.run('sample');
  writeFileSync(path.join(f.processDir, 'smaps_rollup'), 'Rss: 65536 kB\nPss: 40000 kB\n');
  const cached = f.run('quick');
  assert.equal(cached.mem_rss_kb, '32768');
  assert.equal(cached.mem_source, 'rollup_sample');
  writeFileSync(path.join(f.processDir, 'stat'), '1234 (AdGuardHome) S ' + Array(18).fill('0').join(' ') + ' 99999\n');
  const restarted = f.run('quick');
  assert.equal(restarted.mem_rss_kb, '2300');
  assert.equal(restarted.mem_source, 'status_estimate');
  assert.equal(restarted.mem_pss_kb, 'unavailable');
});

test('permission/read failure does not parse partial rollup output as a valid sample', t => {
  const f = fixture(t, 'VmRSS: 0 kB\n');
  const bin = path.join(f.root.dir, 'mock-bin'); mkdirSync(bin);
  const awk = path.join(bin, 'awk');
  writeFileSync(awk, '#!/bin/sh\ncase "$*" in *smaps_rollup*) printf "32768 25484\\n"; exit 1;; esac\nexec /usr/bin/awk "$@"\n'); chmodSync(awk, 0o755);
  f.env.ABP_MEMORY_TEST_BIN = shellPath(bin);
  const result = f.run('sample');
  assert.equal(result.mem_rss_kb, 'unavailable');
  assert.equal(result.mem_pss_kb, 'unavailable');
});

test('process replacement during memory reading invalidates the result and the cache', t => {
  const f = fixture(t);
  const bin = path.join(f.root.dir, 'mock-bin'); mkdirSync(bin);
  const awk = path.join(bin, 'awk');
  writeFileSync(awk, '#!/bin/sh\ncase "$*" in *smaps_rollup*) printf "5678\\n" > "$ABP_AGH_DIR/bin/agh.pid";; esac\nexec /usr/bin/awk "$@"\n'); chmodSync(awk, 0o755);
  f.env.ABP_MEMORY_TEST_BIN = shellPath(bin);
  const result = f.run('sample');
  assert.equal(result.mem_rss_kb, 'unavailable');
  assert.equal(result.mem_pss_kb, 'unavailable');
});

test('different or invalid expected PID never reads another process memory', t => {
  const f = fixture(t);
  for (const pid of ['2345', '0', '../1234']) assert.equal(f.run('sample', pid).mem_rss_kb, 'unavailable');
  writeFileSync(path.join(f.processDir, 'cmdline'), '/another/AdGuardHome\0');
  assert.equal(f.run('sample').mem_rss_kb, 'unavailable');
});

test('rollup with PSS greater than RSS is rejected rather than displayed as healthy', t => {
  const f = fixture(t, 'VmRSS: 0 kB\n', 'Rss: 10 kB\nPss: 25484 kB\n');
  assert.equal(f.run('sample').mem_rss_kb, 'unavailable');
});

test('status delegates only quick memory reading and passes its verified PID to diagnosis', () => {
  const source = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
  const status = source.split('status() {')[1].split('save_snapshot() {')[0];
  assert.match(status, /memory\.sh" quick "\$pid"/);
  assert.doesNotMatch(status, /smaps|footprint\.sh/);
  assert.match(source, /footprint\.sh" "\$pid"/);
});
