import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const source = readFileSync(new URL('../webui-job.sh', import.meta.url), 'utf8');

function fixture(t, family = 'Magisk', options = {}) {
  const f = rootFixture(t);
  f.addBusybox(family);
  const state = path.join(f.dir, 'state');
  const jobs = path.join(state, 'webui-jobs');
  mkdirSync(jobs, { recursive: true });
  const current = path.join(f.dir, 'current-cgroup');
  const target = path.join(f.dir, 'system-cgroup');
  const executed = path.join(f.dir, 'executed');
  writeFileSync(current, options.groups || '4:memory:/apps\n0::/apps/uid_10001/pid_999\n');
  if (options.denied) mkdirSync(target);
  // Emulate the kernel changing membership after a cgroup.procs write.
  const bb = f.paths[family];
  const contents = readFileSync(bb, 'utf8');
  writeFileSync(bb, contents.replace('case "$1" in', `case "$1" in
  cat)
    shift
    if [ "$1" = "$CGROUP_CURRENT" ]; then
      [ "$CGROUP_READ_FAIL" != 1 ] || exit 1
      if [ -f "$CGROUP_TARGET" ] && [ -s "$CGROUP_TARGET" ] && [ "$CGROUP_STUCK" != 1 ]; then
        printf '0::/\\n'; exit 0
      fi
    fi
    exec cat "$@" ;;
`));
  const script = path.join(f.dir, 'webui-job.sh');
  writeFileSync(script, source
    .replaceAll('/data/adb/bindhosts_personal', shellPath(state))
    .replaceAll('/proc/self/cgroup', shellPath(current))
    .replaceAll('/sys/fs/cgroup/cgroup.procs', shellPath(target))
    .replaceAll('/system/bin/sh', 'bash'));
  writeFileSync(path.join(jobs, '1001.log'), 'submitted\n');
  writeFileSync(path.join(f.dir, 'bindhosts.sh'), `#!/bin/sh
${options.requireMove ? '[ -s "$CGROUP_TARGET" ] || exit 17' : ''}
printf '%s\\n' "$PPID" > "$CGROUP_EXECUTED"
`);
  const run = () => spawnSync('bash', [shellPath(script), 'worker', '1001', '--observe', '10', 'com.example.test'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...f.env(family), CGROUP_CURRENT: shellPath(current), CGROUP_TARGET: shellPath(target),
      CGROUP_EXECUTED: shellPath(executed), CGROUP_STUCK: options.stuck ? '1' : '',
      CGROUP_READ_FAIL: options.readFail ? '1' : '' },
  });
  return { run, target, executed, jobs };
}

for (const family of ['KernelSU', 'Magisk', 'APatch']) {
  test(family + ': worker leaves the manager freezer before starting observation', t => {
    const f = fixture(t, family, { requireMove: true });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(f.jobs, '1001.done'), 'utf8').trim(), '0');
    assert.match(readFileSync(f.target, 'utf8'), /^[0-9]+\n$/);
    assert.equal(existsSync(f.executed), true);
    assert.equal(readFileSync(f.target, 'utf8'), readFileSync(f.executed, 'utf8'));
  });
}

test('legacy Android v2 uid paths also leave the manager freezer', t => {
  const f = fixture(t, 'Magisk', { groups: '0::/uid_10001/pid_999\n', requireMove: true });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(f.jobs, '1001.done'), 'utf8').trim(), '0');
  assert.equal(readFileSync(f.target, 'utf8'), readFileSync(f.executed, 'utf8'));
});

for (const groups of ['0::/\n', '0::/system\n', '4:memory:/apps\n3:cpuset:/top-app\n']) {
  test('non-app or legacy cgroups do not cause a migration: ' + groups.trim(), t => {
    const f = fixture(t, 'Magisk', { groups });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path.join(f.jobs, '1001.done'), 'utf8').trim(), '0');
    assert.equal(existsSync(f.target), false);
    assert.equal(existsSync(f.executed), true);
  });
}

for (const options of [{ denied: true }, { stuck: true }, { readFail: true }]) {
  test('unsafe or unconfirmed freezer escape fails before changing query logs: ' + JSON.stringify(options), t => {
    const f = fixture(t, 'Magisk', options);
    f.run();
    assert.equal(readFileSync(path.join(f.jobs, '1001.done'), 'utf8').trim(), '1');
    assert.equal(existsSync(f.executed), false);
    assert.match(readFileSync(path.join(f.jobs, '1001.log'), 'utf8'), /freezer/);
  });
}
