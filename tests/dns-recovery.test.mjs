import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const source = readFileSync(new URL('../scripts/tool.sh', import.meta.url), 'utf8');

function fixture(t, { realStart = false } = {}) {
  const f = rootFixture(t);
  f.addBusybox('Magisk');
  const state = path.join(f.dir, 'state'), agh = path.join(f.dir, 'agh'), mod = path.join(f.dir, 'module');
  for (const p of [state, path.join(state, 'webui-jobs'), path.join(agh, 'bin'), path.join(agh, 'scripts'), mod]) mkdirSync(p, { recursive: true });
  const tool = path.join(agh, 'scripts/tool.sh'), calls = path.join(f.dir, 'calls');
  writeFileSync(path.join(agh, 'bin/agh.pid'), '777\n');
  const prefix = `#!/usr/bin/env bash
BB='${shellPath(f.paths.Magisk)}'
AGH_DIR='${shellPath(agh)}'
BIN_DIR="$AGH_DIR/bin"
SCRIPT_DIR="$AGH_DIR/scripts"
PID_FILE="$BIN_DIR/agh.pid"
MOD_PATH='${shellPath(mod)}'
enable_iptables=true
startup_timeout=2
log() { printf '%s\\n' "$2" >> '${shellPath(calls)}'; }
update_description() { :; }
`;
  const overrides = `
is_our_adguardhome() { [ -f "$AGH_DIR/alive" ]; }
stop_adguardhome() { echo stop >> '${shellPath(calls)}'; }
wait_for_dns_ready() {
  if [ "$HOLD_START" = 1 ]; then
    touch "$AGH_DIR/starting"
    while [ ! -f "$AGH_DIR/release" ]; do sleep 0.02; done
  fi
  [ "$CANCEL_READY" != 1 ] || echo stop:manual > "$RUNTIME_REQUEST"
  return "\${NOT_READY:-0}"
}
${realStart ? '' : `start_adguardhome() {
  start_requested || return 75
  echo start >> '${shellPath(calls)}'
  return "\${START_RESULT:-0}"
}`}
`;
  const code = source.replace(/^#![^\n]*\n/, '')
    .replace(/^\. \/data\/adb\/adblockpro\/(?:settings.conf|scripts\/base.sh)\r?$/gm, '')
    .replace(/^move_to_system_cgroup\r?$/m, '')
    .replaceAll('/data/adb/bindhosts_personal', shellPath(state));
  const index = code.indexOf('\ncase "$1" in\n');
  assert(index > 0);
  writeFileSync(tool, prefix + code.slice(0, index) + overrides + code.slice(index));
  writeFileSync(path.join(agh, 'scripts/iptables.sh'), `#!/bin/sh
echo "$1" >> '${shellPath(calls)}'
case "$1" in status) echo "\${FIREWALL_STATE:-absent}" ;; esac
`);
  chmodSync(path.join(agh, 'scripts/iptables.sh'), 0o755);
  const run = (args, env = {}) => spawnSync('bash', [shellPath(tool), ...args], { encoding: 'utf8', timeout: 10000, env: { ...f.env('Magisk'), ...env } });
  const request = value => writeFileSync(path.join(state, 'runtime-request'), value + '\n');
  const output = () => existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  return { state, agh, mod, run, request, output, tool, f };
}

test('manual start/stop publish current intent; old recovery cannot override a pause', t => {
  const f = fixture(t);
  assert.equal(f.run(['start']).status, 0);
  assert.match(readFileSync(path.join(f.state, 'runtime-request'), 'utf8'), /^run:/);
  assert.equal(f.run(['stop']).status, 0);
  assert.match(readFileSync(path.join(f.state, 'runtime-request'), 'utf8'), /^stop:/);
  assert.equal(f.run(['__locked', 'recover', 'run:old']).status, 75);
  assert.equal(f.output(), 'start\nstop\n');
});

for (const marker of ['disable', 'remove']) test(`recovery refuses a module marked ${marker}`, t => {
  const f = fixture(t); f.request('run:manual'); writeFileSync(path.join(f.mod, marker), '');
  assert.equal(f.run(['recover']).status, 75);
  assert.equal(f.output(), '');
});

for (const state of ['present', 'unknown', '']) test(`recovery refuses unconfirmed firewall absence: ${state || 'empty'}`, t => {
  const f = fixture(t); f.request('run:manual');
  const env = { FIREWALL_STATE: state };
  if (!state) writeFileSync(path.join(f.agh, 'scripts/iptables.sh'), '#!/bin/sh\nexit 1\n');
  assert.equal(f.run(['recover'], env).status, 75);
  assert.doesNotMatch(f.output(), /start/);
});

test('a live core is never duplicated by recovery', t => {
  const f = fixture(t); f.request('run:manual'); writeFileSync(path.join(f.agh, 'alive'), '');
  assert.equal(f.run(['recover']).status, 75);
  assert.equal(f.output(), '');
});

test('only an acquired recovery attempt returns failed-attempt code 2', t => {
  const f = fixture(t); f.request('run:manual');
  assert.equal(f.run(['recover'], { START_RESULT: '1' }).status, 2);
  assert.match(f.output(), /尝试自动恢复/);
  assert.match(f.output(), /start/);
});

for (const [name, env] of [['listener timeout', { NOT_READY: '1' }], ['pause during startup', { CANCEL_READY: '1' }]]) {
  test(`${name} cannot install redirects`, t => {
    const f = fixture(t, { realStart: true });
    writeFileSync(path.join(f.agh, 'alive'), '');
    assert.notEqual(f.run(['start'], env).status, 0);
    assert.doesNotMatch(f.output(), /^enable$/m);
  });
}

for (const lock of ['runtime.lock', 'update.lock', 'webui-jobs/worker.lock']) {
  test(`recovery skips an occupied ${lock} without starting the core`, t => {
    if (process.platform === 'win32' || spawnSync('flock', ['--version']).status !== 0) return t.skip('requires Linux flock');
    const f = fixture(t); f.request('run:manual');
    // Use real flock, unlike rootFixture's cross-platform capability stub.
    writeFileSync(f.f.paths.Magisk, '#!/bin/sh\n[ "$1" != sh ] || { shift; exec bash "$@"; }\nexec "$@"\n');
    const r = spawnSync('flock', ['-n', path.join(f.state, lock), 'bash', f.tool, 'recover'], { encoding: 'utf8', env: f.f.env('Magisk') });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(f.output(), '');
    assert.equal(f.run(['recover']).status, 0);
    assert.match(f.output(), /start/);
  });
}

test('boot intent reset precedes autostart, so last boot cannot defeat autostart off', () => {
  const service = readFileSync(new URL('../service.sh', import.meta.url), 'utf8');
  const reset = service.indexOf('rm -f "$STATE_DIR/runtime-request"');
  assert(reset > 0 && reset < service.indexOf('if [ "$(cat "$AUTOSTART"'));
});

test('a queued pause supersedes a slow start while the real lifecycle lock is held', async t => {
  if (process.platform === 'win32' || spawnSync('flock', ['--version']).status !== 0) return t.skip('requires Linux flock');
  const f = fixture(t, { realStart: true });
  writeFileSync(path.join(f.agh, 'alive'), '');
  writeFileSync(f.f.paths.Magisk, '#!/bin/sh\n[ "$1" != sh ] || { shift; exec bash "$@"; }\nexec "$@"\n');
  const children = [];
  const launch = (action, env = {}) => {
    const child = spawn('bash', [f.tool, action], { env: { ...f.f.env('Magisk'), ...env }, stdio: 'ignore' });
    children.push(child);
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  };
  const waitFor = async predicate => {
    for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(20); }
    assert.fail('lifecycle fixture did not reach its synchronization point');
  };
  try {
    const starting = launch('start', { HOLD_START: '1' });
    await waitFor(() => existsSync(path.join(f.agh, 'starting')));
    const stopping = launch('stop');
    await waitFor(() => readFileSync(path.join(f.state, 'runtime-request'), 'utf8').startsWith('stop:'));
    writeFileSync(path.join(f.agh, 'release'), '');
    assert.notEqual(await starting, 0);
    assert.equal(await stopping, 0);
    assert.doesNotMatch(f.output(), /^enable$/m);
    assert.match(f.output(), /^stop$/m);
  } finally {
    writeFileSync(path.join(f.agh, 'release'), '');
    for (const c of children) c.kill();
  }
});
