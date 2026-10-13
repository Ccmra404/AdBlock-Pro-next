import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';

const service = readFileSync(new URL('../service.sh', import.meta.url), 'utf8');
const firewall = readFileSync(new URL('../scripts/iptables.sh', import.meta.url), 'utf8');
const monitorStart = service.indexOf('# Fail open if the resolver crashes');
assert(monitorStart >= 0);

function run(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-watchdog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mod = path.join(dir, 'module');
  const agh = path.join(dir, 'agh');
  const state = path.join(dir, 'state');
  const proc = path.join(dir, 'proc');
  for (const folder of [mod, path.join(agh, 'bin'), path.join(agh, 'scripts'), state, path.join(proc, '777')]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(agh, 'bin/agh.pid'), '777\n');
  writeFileSync(path.join(state, 'dns-takeover'), options.takeover || 'on');
  const cmdline = path.join(proc, '777/cmdline');
  if (options.alive) writeFileSync(cmdline, shellPath(agh) + '/bin/AdGuardHome\0');
  if (options.disabled) writeFileSync(path.join(mod, 'disable'), '');
  const jumps = path.join(dir, 'jumps');
  writeFileSync(jumps, options.absent ? '0\n' : '1\n');
  const calls = path.join(dir, 'calls');
  const iptables = path.join(dir, 'iptables');
  writeFileSync(iptables, `#!/bin/sh
printf '%s %s\\n' "\${0##*/}" "$*" >> "$CALLS"
[ "$1" != -w ] || shift 2
table=$2; shift 2
action=$1; chain=$2
if [ "\${0##*/}" = ip6tables ]; then
  if [ "$IP6_UNKNOWN" = 1 ]; then exit 1; fi
  echo "ip6tables: can't initialize ip6tables table '$table': Table does not exist" >&2
  exit 3
fi
case "$action" in
  -C) exit "\${CHECK_RESULT:-1}" ;;
  -S)
    [ -z "$QUERY_RESULT" ] || exit "$QUERY_RESULT"
    if [ "$FAIL_AFTER_DELETE" = 1 ] && [ "$(cat "$JUMPS")" = 0 ]; then exit 1; fi
    [ "$EMPTY_SNAPSHOT" != 1 ] || exit 0
    if [ "$INVALID_SNAPSHOT" = 1 ]; then echo malformed; exit 0; fi
    echo '-P OUTPUT ACCEPT'
    [ "$(cat "$JUMPS")" = 0 ] || echo '-A OUTPUT -j ADGUARD_REDIRECT_DNS'
    ;;
  -D)
    [ "$DELETE_FAIL" != 1 ] || exit 1
    echo 0 > "$JUMPS"
    ;;
  -L|-F|-X) exit 0 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(iptables, 0o755);
  const ip6 = path.join(dir, 'ip6tables');
  writeFileSync(ip6, readFileSync(iptables));
  chmodSync(ip6, 0o755);
  const fw = path.join(agh, 'scripts/iptables.sh');
  writeFileSync(fw, firewall
    .replace(/^#![^\n]*\n/, '#!/usr/bin/env bash\n[ "$BROKEN_HELPER" != 1 ] || exit 1\nlog() { :; }\n')
    .replace(/^\. \/data\/adb\/adblockpro\/(?:settings.conf|scripts\/base.sh)\r?$/gm, ''));
  chmodSync(fw, 0o755);
  const bb = path.join(dir, 'bb');
  writeFileSync(bb, '#!/bin/sh\nexec "$@"\n');
  chmodSync(bb, 0o755);
  const body = [
    'MODDIR="' + shellPath(mod) + '"',
    'BB="' + shellPath(bb) + '"',
    'ticks=0',
    `sleep() {
      ticks=$((ticks + 1))
      if [ "$CRASH_ON_SECOND" = 1 ] && [ "$ticks" = 2 ]; then rm -f "$CMDLINE"; fi
      if [ "$ticks" -gt "\${PASSES:-1}" ]; then rm -f "$MODDIR/disable"; rmdir "$MODDIR"; fi
    }`,
    'kill() { echo unexpected-kill >> "$CALLS"; return 1; }',
    service.slice(monitorStart)
      .replaceAll('/data/adb/adblockpro', shellPath(agh))
      .replaceAll('/data/adb/bindhosts_personal', shellPath(state))
      .replaceAll('/proc/', shellPath(proc) + '/')
      .replace(/\) >\/dev\/null 2>&1 &\s*$/, ')'),
  ].join('\n');
  const result = spawnSync('bash', ['-c', body], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
      CALLS: shellPath(calls), JUMPS: shellPath(jumps), CMDLINE: shellPath(cmdline), ...options.env },
  });
  assert.equal(result.status, 0, result.stderr);
  const log = path.join(agh, 'history.log');
  return {
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    residual: readFileSync(jumps, 'utf8').trim() === '1',
    alive: existsSync(cmdline),
  };
}

for (const code of ['1', '2']) test('crashed core: a broken -C query cannot hide a snapshot-visible redirect (' + code + ')', t => {
  const r = run(t, { env: { CHECK_RESULT: code } });
  assert.equal(r.residual, false);
  assert.match(r.log, /已解除/);
  assert.doesNotMatch(r.calls, / -C /);
});

for (const env of [{ QUERY_RESULT: '1' }, { QUERY_RESULT: '2' }, { EMPTY_SNAPSHOT: '1' }, { INVALID_SNAPSHOT: '1' }]) {
  test('unknown firewall status warns once, retries and never reports recovery: ' + JSON.stringify(env), t => {
    const r = run(t, { env: { ...env, PASSES: '3' } });
    assert.equal(r.residual, true);
    assert.doesNotMatch(r.log, /已解除/);
    assert.equal((r.log.match(/\[警告\]/g) || []).length, 1);
    assert((r.calls.match(/-S OUTPUT/g) || []).length >= 3);
  });
}

test('failed cleanup leaves the actual residual and does not claim success', t => {
  const r = run(t, { env: { DELETE_FAIL: '1' } });
  assert.equal(r.residual, true);
  assert.match(r.log, /\[警告\]/);
  assert.doesNotMatch(r.log, /已解除/);
});

test('unknown verification after cleanup cannot be reported as successful', t => {
  const r = run(t, { env: { FAIL_AFTER_DELETE: '1' } });
  assert.equal(r.residual, false);
  assert.match(r.log, /\[警告\]/);
  assert.doesNotMatch(r.log, /已解除/);
});

test('a helper initialization failure with exit 1 is unknown, never confirmed absent', t => {
  const r = run(t, { env: { BROKEN_HELPER: '1' } });
  assert.equal(r.residual, true);
  assert.match(r.log, /\[警告\]/);
  assert.doesNotMatch(r.log, /已解除/);
});

test('explicit absence is quiet and does not mutate the firewall', t => {
  const r = run(t, { absent: true, takeover: 'off' });
  assert.equal(r.log, '');
  assert.doesNotMatch(r.calls, / -[DFX] /);
});

test('a healthy enabled core is left alone even when firewall queries would fail', t => {
  const r = run(t, { alive: true, env: { QUERY_RESULT: '1', PASSES: '2' } });
  assert.equal(r.alive, true);
  assert.equal(r.residual, true);
  assert.equal(r.log, '');
  assert.equal(r.calls, '');
});

test('the running monitor detects a later core exit and cleans only its redirect', t => {
  const r = run(t, { alive: true, env: { CRASH_ON_SECOND: '1', PASSES: '2' } });
  assert.equal(r.alive, false);
  assert.equal(r.residual, false);
  assert.match(r.log, /已解除/);
  assert.doesNotMatch(r.calls, /unexpected-kill/);
});

test('a saved off preference cannot hide residual redirects after a crash', t => {
  const r = run(t, { takeover: 'off' });
  assert.equal(r.residual, false);
  assert.match(r.log, /已解除/);
});

test('disable cleanup never terminates a still-running core', t => {
  const r = run(t, { alive: true, disabled: true });
  assert.equal(r.alive, true);
  assert.equal(r.residual, false);
  assert.match(r.log, /模块已禁用，已解除/);
  assert.doesNotMatch(r.calls, /unexpected-kill/);
});

test('an unknown IPv6 backend cannot produce an all-clear recovery message', t => {
  const r = run(t, { env: { IP6_UNKNOWN: '1' } });
  assert.equal(r.residual, false);
  assert.match(r.log, /\[警告\]/);
  assert.doesNotMatch(r.log, /已解除/);
});
