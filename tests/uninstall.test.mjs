import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';

const source = readFileSync(new URL('../uninstall.sh', import.meta.url), 'utf8');
const toolSource = readFileSync(new URL('../scripts/tool.sh', import.meta.url), 'utf8');
const firewallSource = readFileSync(new URL('../scripts/iptables.sh', import.meta.url), 'utf8');
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-uninstall-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'runtime'), state = path.join(dir, 'state');
  mkdirSync(path.join(runtime, 'scripts'), { recursive: true });
  mkdirSync(state);
  writeFileSync(path.join(runtime, 'admin.auth'), 'fixture-only');
  writeFileSync(path.join(state, 'whitelist.txt'), 'keep.example\n');
  const tool = path.join(runtime, 'scripts/tool.sh');
  if (overrides.REAL_STOP === '1') {
    const firewall = path.join(runtime, 'scripts/iptables.sh');
    writeFileSync(firewall, '#!/bin/bash\nlog() { :; }\n' + firewallSource
      .replace(/^#![^\n]*\n/, '').replace(/^\. \/data\/adb\/adblockpro\/(?:settings.conf|scripts\/base.sh)\r?$/gm, ''));
    chmodSync(firewall, 0o755);
    const stopBody = toolSource.slice(toolSource.indexOf('stop_adguardhome() {'), toolSource.indexOf('\ntoggle_adguardhome()'));
    writeFileSync(path.join(runtime, 'AdGuardHome.pid'), '12345\n');
    writeFileSync(path.join(runtime, 'live'), 'resolver running');
    writeFileSync(tool, `#!/bin/bash
SCRIPT_DIR='${shellPath(path.join(runtime, 'scripts'))}'
PID_FILE='${shellPath(path.join(runtime, 'AdGuardHome.pid'))}'
log() { :; }
update_description() { :; }
is_our_adguardhome() { [ -e '${shellPath(path.join(runtime, 'live'))}' ]; }
kill() { touch '${shellPath(path.join(runtime, 'killed'))}'; rm '${shellPath(path.join(runtime, 'live'))}'; }
${stopBody}
stop_adguardhome
`);
  } else writeFileSync(tool, '#!/bin/sh\nexit "${STOP_RESULT:-0}"\n');
  chmodSync(tool, 0o755);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const mock = `#!/bin/sh
family=IP4
case "$0" in *ip6tables)
  family=IP6
  if [ "$IP6_UNAVAILABLE" = 1 ]; then
    echo "ip6tables: can't initialize ip6tables table nat: Table does not exist (do you need to insmod?)" >&2
    exit 3
  fi ;;
esac
case "$*" in
  *"-L OUTPUT"*) [ "$IP6_PROBE_FAILURE" != 1 ] || exit 1; exit 0 ;;
  *"-S OUTPUT"*)
    if [ "$family" = IP4 ]; then
      [ -z "$IP4_QUERY_RESULT" ] || exit "$IP4_QUERY_RESULT"
      chain=ADGUARD_REDIRECT_DNS
      present=$IP4_JUMP
    else
      [ -z "$IP6_QUERY_RESULT" ] || exit "$IP6_QUERY_RESULT"
      case "$*" in *"-t nat"*) chain=ADGUARD_REDIRECT_DNS6 ;; *) chain=ADGUARD_BLOCK_DNS ;; esac
      present=$IP6_JUMP
    fi
    [ "$EMPTY_SNAPSHOT" != 1 ] || exit 0
    [ "$INVALID_SNAPSHOT" != 1 ] || { echo malformed; exit 0; }
    echo '-P OUTPUT ACCEPT'
    [ "$present" != 1 ] || echo "-A OUTPUT -j $chain"
    exit 0 ;;
  *"-C OUTPUT"*) exit 1 ;;
  *"-D OUTPUT"*) exit 1 ;;
esac
exit 2
`;
  for (const name of ['iptables', 'ip6tables']) {
    const file = path.join(bin, name);
    writeFileSync(file, mock); chmodSync(file, 0o755);
  }
  const result = spawnSync('bash', ['-c', source.replaceAll('/data/adb/adblockpro', shellPath(runtime))], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...overrides },
  });
  assert.equal(readFileSync(path.join(state, 'whitelist.txt'), 'utf8'), 'keep.example\n');
  return { result, runtime };
}

for (const options of [
  { STOP_RESULT: '1' }, { IP4_JUMP: '1' }, { IP4_QUERY_RESULT: '1' }, { IP4_QUERY_RESULT: '2' },
  { IP6_JUMP: '1' }, { IP6_QUERY_RESULT: '1' }, { IP6_QUERY_RESULT: '2' },
  { IP6_QUERY_RESULT: '1', IP6_PROBE_FAILURE: '1' },
  { EMPTY_SNAPSHOT: '1' }, { INVALID_SNAPSHOT: '1' },
]) {
  test('unsafe uninstall preserves runtime: ' + JSON.stringify(options), t => {
    const { result, runtime } = fixture(t, options);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(runtime, 'admin.auth')), true);
  });
}

for (const options of [{ IP4_QUERY_RESULT: '1' }, { IP4_JUMP: '1' }, { IP6_QUERY_RESULT: '1' }]) {
  test('real stop preserves resolver PID and runtime on unknown or residual firewall: ' + JSON.stringify(options), t => {
    const { result, runtime } = fixture(t, { ...options, REAL_STOP: '1' });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(runtime, 'admin.auth')), true);
    assert.equal(readFileSync(path.join(runtime, 'AdGuardHome.pid'), 'utf8'), '12345\n');
    assert.equal(existsSync(path.join(runtime, 'killed')), false, 'must not signal a resolver still needed by DNS');
    assert.equal(existsSync(path.join(runtime, 'live')), true);
  });
}
for (const options of [{}, { IP6_UNAVAILABLE: '1' }, { REAL_STOP: '1' }, { REAL_STOP: '1', IP6_UNAVAILABLE: '1' }]) {
  test('verified cleanup can remove runtime without touching personal state: ' + JSON.stringify(options), t => {
    const { result, runtime } = fixture(t, options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(runtime), false);
  });
}
