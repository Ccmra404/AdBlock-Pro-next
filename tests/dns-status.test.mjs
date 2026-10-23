import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function statusFixture(t, { takeover = 'on', vpnCompat = 'off', vpnState = '', listener = true, redirect = true, running = true, api = true, filtering = '{"enabled":true,"filters":[]}' } = {}) {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const runtime = path.join(root.dir, 'runtime'), state = path.join(root.dir, 'state'), proc = path.join(root.dir, 'proc');
  for (const dir of [path.join(runtime, 'bin'), path.join(runtime, 'scripts'), state, path.join(proc, 'net'), path.join(proc, '1234')]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(runtime, 'bin/agh.pid'), '1234\n');
  writeFileSync(path.join(runtime, 'admin.auth'), 'fixture-only\n');
  writeFileSync(path.join(proc, '1234/cmdline'), shellPath(runtime) + '/bin/AdGuardHome\0');
  writeFileSync(path.join(proc, '1234/stat'), '1234 (AdGuardHome) S ' + Array(18).fill('0').join(' ') + ' 12345\n');
  writeFileSync(path.join(proc, '1234/status'), 'VmRSS: 0 kB\n');
  writeFileSync(path.join(proc, '1234/smaps_rollup'), 'Rss: 32768 kB\nPss: 25484 kB\n');
  writeFileSync(path.join(proc, 'net/udp'), 'header\n0: 0100007F:15D7 00000000:0000 07\n');
  writeFileSync(path.join(proc, 'net/tcp'), 'header\n' + (listener ? '0: 0100007F:15D7 00000000:0000 0A\n' : ''));
  writeFileSync(path.join(state, 'dns-takeover'), takeover + '\n');
  writeFileSync(path.join(state, 'vpn-compat'), vpnCompat + '\n');
  writeFileSync(path.join(state, 'vpn-compat-state'), vpnState ? vpnState + '\n' : '');
  writeFileSync(path.join(state, 'engine-version'), 'fixture-engine\n');
  writeFileSync(path.join(root.dir, 'module.prop'), 'version=v0.13.0-rc.3\n');
  for (const file of ['memory.sh', 'footprint.sh']) writeFileSync(path.join(runtime, 'scripts', file), readFileSync(new URL('../scripts/' + file, import.meta.url), 'utf8'));
  const curl = path.join(root.dir, 'curl');
  const requests = path.join(root.dir, 'requests');
  writeFileSync(curl, '#!/bin/sh\n' + (api ? '' : 'exit 1\n') + `printf '%s\\n' "$*" >> '${shellPath(requests)}'\n` + `case "$*" in */filtering/status*) printf '%s\\n' '${filtering}';; *) echo '{}';; esac\n`); chmodSync(curl, 0o755);
  const source = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8')
    .replaceAll('/data/adb/adblockpro', shellPath(runtime)).replaceAll('/data/adb/bindhosts_personal', shellPath(state))
    .replaceAll('/proc/', shellPath(proc) + '/');
  const script = path.join(root.dir, 'bindhosts.sh');
  writeFileSync(script, `kill() { return ${running ? 0 : 1}; }\niptables() { return ${redirect ? 0 : 1}; }\n` + source);
  function run(command = '--status', ...args) {
    const result = spawnSync('bash', [shellPath(script), command, ...args], { timeout: 15000, encoding: 'utf8', env: {
      ...root.env('Magisk'), CURL: shellPath(curl), ABP_AGH_DIR: shellPath(runtime), ABP_STATE_DIR: shellPath(state), ABP_PROC_DIR: shellPath(proc),
    } });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(result.stdout.trim().split(/\n| (?=blocked=|mode=)/).map(row => {
      const index = row.indexOf('='); return [row.slice(0, index), row.slice(index + 1)];
    }));
  }
  run.requests = () => readFileSync(requests, 'utf8');
  return run;
}

for (const [name, filtering, expected] of [
  ['enabled subscription and paused global filtering', '{"filters":[{"enabled":true}],"interval":24,"enabled":false}', 'false'],
  ['disabled subscription and enabled global filtering', '{"filters":[{"enabled":false}],"enabled":true,"interval":24}', 'true'],
  ['global key before subscriptions', '{"enabled":false,"filters":[{"enabled":true}],"interval":24}', 'false'],
  ['escaped text and multiline response', '{\n"filters":[{"name":"fake \\"enabled\\":true ] }","enabled":true}],\n"enabled" : false,"interval":24}', 'false'],
  ['missing global key', '{"filters":[{"enabled":true}],"interval":24}', 'unknown'],
  ['nonboolean global value', '{"filters":[{"enabled":true}],"enabled":null,"interval":24}', 'unknown'],
]) {
  test('filtering state reads only the top-level switch: ' + name, t => {
    assert.equal(statusFixture(t, { filtering })().filtering_enabled, expected);
  });
}

test('changing update interval preserves paused filtering despite enabled subscriptions', t => {
  const run = statusFixture(t, { filtering: '{"filters":[{"enabled":true}],"interval":24,"enabled":false}' });
  run('--set-auto-update', 'off');
  assert.match(run.requests(), /--data-binary \{"enabled":false,"interval":0\}/);
});

for (const [title, options, health, state] of [
  ['active takeover', {}, 'active', 'active'],
  ['user disabled takeover', { takeover: 'off', redirect: false }, 'takeover_off', 'bypassed'],
  ['redirect left after takeover disabled', { takeover: 'off' }, 'takeover_cleanup_pending', 'degraded'],
  ['unreadable management API', { api: false }, 'api_failed', 'degraded'],
  ['missing TCP listener even when takeover off', { listener: false, takeover: 'off', redirect: false }, 'listener_failed', 'degraded'],
  ['failed firewall takeover', { redirect: false }, 'takeover_failed', 'degraded'],
  ['VPN TUN pause', { vpnCompat: 'on', vpnState: 'vpn', redirect: false }, 'vpn_paused', 'bypassed'],
  ['unknown VPN state pause', { vpnCompat: 'on', vpnState: 'unknown', redirect: false }, 'vpn_state_unknown', 'bypassed'],
  ['waiting to resume after VPN', { vpnCompat: 'on', vpnState: 'resume_wait', redirect: false }, 'vpn_resume_wait', 'bypassed'],
  ['VPN pause with redirect still present', { vpnCompat: 'on', vpnState: 'vpn', redirect: true }, 'vpn_compat_error', 'degraded'],
  ['unknown saved preference', { takeover: '' }, 'takeover_unknown', 'degraded'],
  ['stopped core', { running: false }, 'stopped', 'paused'],
]) {
  test('status and diagnosis distinguish ' + title, t => {
    const run = statusFixture(t, options);
    const result = run();
    assert.equal(result.state, state);
    assert.equal(result.dns_health, health);
    assert.equal(result.dns_core_running, options.running === false ? '0' : '1');
    const diag = run('--diagnose');
    assert.equal(diag.diag_dns_health, health);
    assert.equal(diag.diag_service_state, state === 'active' ? 'ready' : state === 'paused' ? 'stopped' : state);
    if (options.running === false) assert.equal(diag.diag_mem_rss_kb, 'unavailable');
    else {
      assert.equal(diag.diag_mem_rss_kb, '32768');
      assert.equal(run().dns_rss_kb, '32768');
      assert.equal(run().dns_mem_source, 'rollup_sample');
    }
  });
}
