import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {rootFixture, shellPath} from './shell-fixture.mjs';

const source = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
const automatic = source.slice(source.indexOf('auto_update_rules() {'), source.indexOf('\ndiagnose() {'));
const failed = source.slice(source.indexOf('update_failed() {'), source.indexOf('\nsource_name() {'));
function fixture(t, options = {}) {
  const f = rootFixture(t); f.addBusybox('Magisk');
  const state = path.join(f.dir, 'state'), agh = path.join(f.dir, 'agh'), mod = path.join(f.dir, 'module');
  for (const p of [state, path.join(agh, 'bin'), mod]) mkdirSync(p, {recursive:true});
  writeFileSync(path.join(agh, 'bin/agh.pid'), '777\n');
  if (options.preference !== undefined) writeFileSync(path.join(state, 'auto-update'), options.preference);
  if (options.last !== undefined) writeFileSync(path.join(state, 'last-update'), String(options.last));
  if (options.attempt !== undefined) writeFileSync(path.join(state, 'auto-update-attempt'), String(options.attempt));
  if (options.disabled) writeFileSync(path.join(mod, 'disable'), '');
  writeFileSync(path.join(mod, 'sources'), options.empty ? '' : 'source\tcustom\tFeed\thttps://feed.example\tenabled\n');
  writeFileSync(path.join(mod, 'webui-config.sh'), '#!/bin/sh\ncat "${0%/*}/sources"\n');
  const script = path.join(f.dir, 'auto.sh');
  writeFileSync(script, [
    'BB=' + shellPath(f.paths.Magisk), 'STATE=' + shellPath(state), 'AGH=' + shellPath(agh), 'MODDIR=' + shellPath(mod),
    'date() { printf "2000000000\\n"; }',
    `is_our_process() { return ${options.dead ? 1 : 0}; }`,
    `is_dns_listening() { return ${options.noListener ? 1 : 0}; }`,
    'update_rules() { echo "$AUTO_UPDATE" >> "$STATE/calls"; ' + (options.failure ? 'return 1;' : 'echo 2000000000 > "$STATE/last-update";') + ' }',
    automatic, 'auto_update_rules',
  ].join('\n'));
  return {state, agh, mod, run:() => spawnSync('bash', [shellPath(script)], {encoding:'utf8', env:f.env('Magisk')})};
}

test('due automatic update calls the real update entry semantics once and respects the last success', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  assert.equal(readFileSync(path.join(f.state, 'calls'), 'utf8'), '1\n');
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(path.join(f.state, 'calls'), 'utf8'), '1\n');
});
for (const [name, options] of [
  ['preference off', {preference:'off'}], ['disabled module', {disabled:true}],
  ['stopped core', {dead:true}], ['unready listener', {noListener:true}],
  ['no enabled sources', {empty:true}], ['not yet due', {last:1999999999}],
  ['failure backoff', {attempt:1999999999}],
]) test(`automatic downloads skip ${name}`, t => {
  const f = fixture(t, options); assert.equal(f.run().status, 0);
  assert.equal(existsSync(path.join(f.state, 'calls')), false);
});

test('failed automatic update preserves last success and waits an hour before retry', t => {
  const f = fixture(t, {failure:true, last:1}); assert.equal(f.run().status, 1);
  assert.equal(readFileSync(path.join(f.state, 'last-update'), 'utf8'), '1');
  assert.equal(readFileSync(path.join(f.state, 'auto-update-attempt'), 'utf8').trim(), '2000000000');
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(path.join(f.state, 'calls'), 'utf8'), '1\n');
});
for (const stamp of ['2099999999', 'invalid', '08', '99999999999999999999999']) {
  test(`clock corrections and malformed timestamp ${stamp} do not suppress future downloads`, t => {
    const f = fixture(t, {last:stamp, attempt:stamp}); assert.equal(f.run().status, 0);
    assert.equal(readFileSync(path.join(f.state, 'calls'), 'utf8'), '1\n');
  });
}

test('automatic failure never restarts a core stopped during the download', t => {
  const f = rootFixture(t), script = path.join(f.dir, 'failed.sh');
  writeFileSync(script, ['MODDIR=' + shellPath(f.dir), 'AGH=' + shellPath(f.dir), 'AUTO_UPDATE=1',
    'LAST_SNAPSHOT=saved', 'is_our_process() { return 1; }', 'restore_snapshot() { echo UNEXPECTED_RESTART; }',
    failed, 'update_failed simulated_failure'].join('\n'));
  const r = spawnSync('bash', [shellPath(script)], {encoding:'utf8'});
  assert.equal(r.status, 1); assert.doesNotMatch(r.stdout, /UNEXPECTED_RESTART/);
  assert.match(r.stderr, /不自动重启核心/);
});

test('daily check shares both locks and is launched separately from the crash watchdog', () => {
  assert.match(source, /flock -n "\$STATE\/webui-jobs\/worker\.lock" "\$BB" flock -n "\$STATE\/update\.lock"/);
  const service = readFileSync(new URL('../service.sh', import.meta.url), 'utf8');
  assert.match(service, /auto_update_ticks" -ge 12/);
  assert.match(service, /sh "\$MODDIR\/bindhosts\.sh" --auto-update >\/dev\/null 2>&1 &/);
});

for (const lock of ['update.lock', 'webui-jobs/worker.lock']) {
  test(`automatic download cannot enter while ${lock} is owned by another operation`, t => {
    if (process.platform === 'win32' || spawnSync('flock', ['--version']).status !== 0) return t.skip('requires Linux flock');
    const f = rootFixture(t); mkdirSync(path.join(f.dir, 'webui-jobs'));
    const script = path.join(f.dir, 'entry.sh');
    const entry = source.slice(source.indexOf('  --auto-update)'), source.indexOf('  --update)'));
    writeFileSync(script, ['STATE=' + shellPath(f.dir), 'BB=env',
      'auto_update_rules() { echo ENTERED; }', 'case "$1" in', entry, 'esac'].join('\n'));
    const r = spawnSync('flock', ['-n', path.join(f.dir, lock), 'bash', script, '--auto-update'], {encoding:'utf8'});
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /ENTERED/);
    const released = spawnSync('bash', [script, '--auto-update'], {encoding:'utf8'});
    assert.equal(released.status, 0, released.stderr);
    assert.match(released.stdout, /ENTERED/);
  });
}
