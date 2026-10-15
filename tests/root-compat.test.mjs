import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { shellPath, rootFixture } from './shell-fixture.mjs';

for (const family of ['KernelSU', 'Magisk', 'APatch']) {
  test(family + ': reads logs, saves personal rules and launches workers with its own tools', async t => {
    const fixture = rootFixture(t);
    fixture.addBusybox(family);
    const state = path.join(fixture.dir, 'state');
    const jobs = path.join(state, 'webui-jobs');
    mkdirSync(jobs, { recursive: true });
    for (const file of ['webui-job.sh', 'webui-config.sh']) {
      const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
        .replaceAll('/data/adb/bindhosts_personal', shellPath(state))
        .replaceAll('/system/bin/sh', 'bash');
      writeFileSync(path.join(fixture.dir, file), source);
    }
    function run(script, args) {
      const result = spawnSync('bash', [shellPath(path.join(fixture.dir, script)), ...args],
        { encoding: 'utf8', env: fixture.env(family), timeout: 10000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    }
    run('webui-config.sh', ['init-profiles']);
    run('webui-job.sh', ['config', 'add-whitelist', 'login.example.com', '1001']);
    assert.equal(readFileSync(path.join(state, 'whitelist.txt'), 'utf8').trim(), 'login.example.com');
    assert.match(run('webui-job.sh', ['recent']), /1001\tsuccess\tadd-whitelist/);
    assert.match(run('webui-job.sh', ['list']), /1001/);
    assert.match(run('webui-job.sh', ['config', 'list-sources', 'balanced']), /秋风纯广告/);
    assert.equal(existsSync(path.join(jobs, '1001.done')), true);
    const oldSource = 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
    const newSource = 'https://mirror.example/ads.txt';
    run('webui-job.sh', ['config', 'edit-source', oldSource, newSource, '1003']);
    assert.match(run('webui-job.sh', ['config', 'list-sources', 'balanced']), /mirror\.example/);
    assert.equal(readFileSync(path.join(jobs, '1003.done'), 'utf8').trim(), '0');
    writeFileSync(path.join(fixture.dir, 'bindhosts.sh'), '#!/bin/sh\nprintf "worker-action=%s\\n" "$1"\n');
    run('webui-job.sh', ['start', '1002', '--filtering', 'on']);
    for (let i = 0; i < 100 && !existsSync(path.join(jobs, '1002.done')); i++) await delay(20);
    assert.equal(readFileSync(path.join(jobs, '1002.done'), 'utf8').trim(), '0');
    assert.match(run('webui-job.sh', ['poll', '1002']), /worker-action=--filtering[\s\S]*JOB_DONE=0/);
  });

  test(family + ': current manager takes priority over stale tool directories', t => {
    const fixture = rootFixture(t);
    for (const root of ['KernelSU', 'Magisk', 'APatch']) fixture.addBusybox(root);
    const result = spawnSync('bash', ['-c', '. "$1" || exit; printf "%s\\n%s" "$BB" "$(abp_root_family)"',
      'compat-test', shellPath(fixture.compatFile)], { encoding: 'utf8', env: fixture.env(family) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), shellPath(fixture.paths[family]) + '\n' + family);
  });

  test(family + ': ordinary root shells use the installed family without manager variables', t => {
    const fixture = rootFixture(t);
    for (const root of ['KernelSU', 'Magisk', 'APatch']) fixture.addBusybox(root);
    writeFileSync(path.join(fixture.dir, 'root-family'), family + '\n');
    const result = spawnSync('bash', ['-c', '. "$1" || exit; printf "%s\\n%s" "$BB" "$(abp_root_family)"',
      'compat-test', shellPath(fixture.compatFile)], { encoding: 'utf8', env: fixture.env() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), shellPath(fixture.paths[family]) + '\n' + family);
  });
}

test('missing locking tools fail before configuration writes', t => {
  const fixture = rootFixture(t, 'flock');
  fixture.addBusybox('Magisk');
  const result = spawnSync('bash', ['-c', '. "$1" || exit 1; touch "$2"', 'compat-test',
    shellPath(fixture.compatFile), shellPath(path.join(fixture.dir, 'modified'))],
    { encoding: 'utf8', env: fixture.env('Magisk') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /complete BusyBox/);
  assert.equal(existsSync(path.join(fixture.dir, 'modified')), false);
});

test('installation stops at preflight when curl is missing', t => {
  const fixture = rootFixture(t);
  fixture.addBusybox('Magisk');
  let compat = readFileSync(fixture.compatFile, 'utf8');
  const missing = shellPath(path.join(fixture.dir, 'missing-curl'));
  compat = compat.replace('/system/bin/curl', missing)
    .replace('/data/adb/adblockpro/bin/curl', missing)
    .replace('$(command -v curl 2>/dev/null)', missing);
  writeFileSync(fixture.compatFile, compat);
  const source = readFileSync(new URL('../customize.sh', import.meta.url), 'utf8');
  const prefix = source.slice(0, source.indexOf('ui_print "[AdBlock Pro] Preparing'));
  assert(prefix.includes('abp_find_curl'));
  const script = `ui_print() { :; }
abort() { echo "$1" >&2; exit 1; }
unzip() { cat "$COMPAT_FIXTURE"; }
${prefix}
touch "$TMPDIR/modified"
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
    ...fixture.env('Magisk'), TMPDIR: shellPath(fixture.dir),
    COMPAT_FIXTURE: shellPath(fixture.compatFile), ZIPFILE: 'fixture.zip',
  } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /curl is missing/);
  assert.equal(existsSync(path.join(fixture.dir, 'modified')), false);
});

for (const stopResult of [0, 1]) {
  test('uninstall ' + (stopResult ? 'retains resolver files after failed shutdown' : 'removes safely stopped runtime files'), t => {
    const fixture = rootFixture(t);
    const runtime = path.join(fixture.dir, 'runtime');
    mkdirSync(path.join(runtime, 'scripts'), { recursive: true });
    const tool = path.join(runtime, 'scripts/tool.sh');
    writeFileSync(tool, '#!/bin/sh\nexit ' + stopResult + '\n');
    chmodSync(tool, 0o755);
    const source = readFileSync(new URL('../uninstall.sh', import.meta.url), 'utf8')
      .replaceAll('/data/adb/adblockpro', shellPath(runtime));
    const result = spawnSync('bash', ['-c', `iptables() { printf '%s\\n' '-P OUTPUT ACCEPT'; }
ip6tables() { echo "ip6tables: can't initialize ip6tables table nat: Table does not exist" >&2; return 3; }
` + source], { encoding: 'utf8' });
    assert.equal(result.status, stopResult, result.stderr);
    assert.equal(existsSync(runtime), stopResult !== 0);
  });
}
