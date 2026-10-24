import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';
import { fileURLToPath } from 'node:url';

const helper = new URL('../scripts/vpn-compat.sh', import.meta.url);

function fixture(t, { vpn = false, paused = vpn, compat = 'on', takeover = 'on', redirect = true, core = true, netReadable = true, failDisable = false, failEnable = false, failDescription = false, interfaces = null, firewallEnabled = 'true', disabled = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'abp-vpn-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agh = path.join(root, 'agh');
  const state = path.join(root, 'state');
  const mod = path.join(root, 'module');
  const sys = path.join(root, 'net');
  const proc = path.join(root, 'proc');
  for (const dir of [path.join(agh, 'scripts'), path.join(agh, 'bin'), state, mod, sys, proc, path.join(proc, '777'), path.join(proc, 'net')]) mkdirSync(dir, { recursive: true });
  if (compat !== null) writeFileSync(path.join(state, 'vpn-compat'), compat + '\n');
  writeFileSync(path.join(state, 'dns-takeover'), takeover + '\n');
  writeFileSync(path.join(state, 'vpn-compat-state'), paused ? 'vpn\n' : '');
  writeFileSync(path.join(state, 'vpn-clear-count'), '0\n');
  writeFileSync(path.join(agh, 'settings.conf'), 'redir_port=5591\nenable_iptables=' + firewallEnabled + '\nreadonly VPN_TEST_SETTING=fixed\n');
  if (disabled) writeFileSync(path.join(mod, 'disable'), '');
  writeFileSync(path.join(agh, 'bin/agh.pid'), '777\n');
  if (core) writeFileSync(path.join(proc, '777/cmdline'), Buffer.from(shellPath(agh) + '/bin/AdGuardHome\0'));
  const netInterfaces = interfaces ?? (vpn ? [['tun0', '0x1001']] : []);
  for (const [name, flags] of netInterfaces) {
    const interfaceDir = path.join(sys, name);
    mkdirSync(interfaceDir, { recursive: true });
    if (flags !== null) writeFileSync(path.join(interfaceDir, 'flags'), flags + '\n');
  }
  if (!netReadable) rmSync(sys, { recursive: true, force: true });
  writeFileSync(path.join(proc, 'net/udp'), 'sl local_address rem_address st\n 0: 0100007F:15D7 00000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 1 00000000\n');
  writeFileSync(path.join(proc, 'net/tcp'), 'sl local_address rem_address st\n 0: 0100007F:15D7 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 1 00000000\n');
  // Android exposes both IPv4 and IPv6 proc tables; keep the fixture aligned
  // so listener checks can prove readiness from either family.
  writeFileSync(path.join(proc, 'net/udp6'), 'sl local_address remote_address st\n');
  writeFileSync(path.join(proc, 'net/tcp6'), 'sl local_address remote_address st\n');
  const fwState = path.join(root, 'redirect');
  const calls = path.join(root, 'firewall-calls');
  const description = path.join(root, 'description');
  const descriptionCalls = path.join(root, 'description-calls');
  writeFileSync(path.join(agh, 'scripts/base.sh'), `update_description() {
    [ "$FAIL_DESCRIPTION" != 1 ] || return 1
    printf '%s\n' "$2" > "$DESCRIPTION_FILE"
    printf '%s\n' "$2" >> "$DESCRIPTION_CALLS"
  }
`);
  writeFileSync(fwState, redirect ? '1\n' : '0\n');
  writeFileSync(path.join(agh, 'scripts/iptables.sh'), `#!/bin/sh
printf '%s\n' "$1" >> "$FIREWALL_CALLS"
 case "$1" in
 status) [ "$(cat "$FIREWALL_STATE")" = 1 ] && { echo present; exit 0; }; echo absent; exit 1 ;;
 disable) [ "$FAIL_DISABLE" != 1 ] || exit 1; printf '0\n' > "$FIREWALL_STATE" ;;
 enable) [ "$FAIL_ENABLE" != 1 ] || exit 1; printf '1\n' > "$FIREWALL_STATE" ;;
 *) exit 2 ;;
esac
`);
  chmodSync(path.join(agh, 'scripts/iptables.sh'), 0o755);
  const bb = path.join(root, 'busybox');
  writeFileSync(bb, '#!/bin/sh\ncase "$1" in sh) shift; exec bash "$@" ;; *) exec "$@" ;; esac\n');
  chmodSync(bb, 0o755);
  function run(...args) {
    return spawnSync('bash', [shellPath(fileURLToPath(helper)), ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, BB: shellPath(bb), ABP_DNS_TRANSITION_LOCKED: '1',
        ABP_AGH_DIR: shellPath(agh), ABP_STATE_DIR: shellPath(state), ABP_MODULE_DIR: shellPath(mod),
        ABP_SYS_CLASS_NET: shellPath(sys), ABP_PROC_ROOT: shellPath(proc),
        FIREWALL_STATE: shellPath(fwState), FIREWALL_CALLS: shellPath(calls), FAIL_DISABLE: failDisable ? '1' : '0', FAIL_ENABLE: failEnable ? '1' : '0',
        DESCRIPTION_FILE: shellPath(description), DESCRIPTION_CALLS: shellPath(descriptionCalls), FAIL_DESCRIPTION: failDescription ? '1' : '0' },
    });
  }
  const readIfPresent = file => {
    try { return readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  };
  return { run, state: name => readIfPresent(path.join(state, name)).trim(), firewall: () => readFileSync(fwState, 'utf8').trim(), calls: () => readIfPresent(calls), history: () => readIfPresent(path.join(agh, 'history.log')), description: () => readIfPresent(description), descriptionCalls: () => readIfPresent(descriptionCalls) };
}

test('startup pauses only module DNS redirection when a TUN interface is present', t => {
  const f = fixture(t, { vpn: true, paused: false });
  const r = f.run('start-guard');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'paused-vpn', 'firewall log output must not pollute the start guard result');
  assert.equal(f.state('vpn-compat-state'), 'vpn');
  assert.equal(f.state('dns-takeover'), 'on');
  assert.equal(f.firewall(), '0');
  assert.match(f.history(), /过滤核心继续运行/);
  assert.match(f.description(), /VPN 旁路/);
});

test('a down kernel tunl0 placeholder is not mistaken for an active VPN', t => {
  const f = fixture(t, { interfaces: [['tunl0', '0x80']] });
  const r = f.run('detect');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'absent');
});

test('an unreadable matching tunnel state remains unknown', t => {
  const f = fixture(t, { interfaces: [['tun0', null]] });
  const r = f.run('detect');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'unknown');
});

test('an unreadable interface directory pauses rather than assuming VPN is absent', t => {
  const f = fixture(t, { netReadable: false });
  const r = f.run('start-guard');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /paused-unknown/);
  assert.equal(f.state('vpn-compat-state'), 'unknown');
  assert.equal(f.firewall(), '0');
  assert.match(f.description(), /VPN 状态未知/);
});

test('redirect resumes only after three consecutive confirmed VPN-absent checks', t => {
  const f = fixture(t, { vpn: false, paused: true, redirect: false });
  for (let i = 0; i < 2; i += 1) {
    const r = f.run('watch');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.firewall(), '0');
    assert.equal(f.state('vpn-compat-state'), 'resume_wait');
    assert.match(f.description(), /等待 VPN 稳定断开/);
  }
  const last = f.run('watch');
  assert.equal(last.status, 0, last.stderr);
  assert.equal(f.firewall(), '1');
  assert.equal(f.state('dns-takeover'), 'on');
  assert.equal(f.state('vpn-compat-state'), '');
  assert.match(f.history(), /连续稳定/);
  assert.match(f.description(), /DNS 防护运行中/);
  assert.doesNotMatch(f.description(), /VPN 旁路/);
});

test('manual takeover off wins over VPN auto-resume', t => {
  const f = fixture(t, { vpn: false, paused: true, takeover: 'off', redirect: false });
  const r = f.run('watch');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.firewall(), '0');
  assert.equal(f.state('dns-takeover'), 'off');
  assert.equal(f.state('vpn-compat-state'), '');
  assert.doesNotMatch(f.calls(), /enable/);
  assert.match(f.description(), /接管关闭/);
});

test('manual takeover on while VPN is active records intent without restoring redirect', t => {
  const f = fixture(t, { vpn: true, takeover: 'off', redirect: false });
  const r = f.run('set-takeover', 'on');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /preference saved/);
  assert.equal(f.state('dns-takeover'), 'on');
  assert.equal(f.state('vpn-compat-state'), 'vpn');
  assert.equal(f.firewall(), '0');
  assert.match(f.description(), /VPN 旁路/);
});

test('manual takeover on requires the resolver to be ready before adding redirects', t => {
  const f = fixture(t, { vpn: false, takeover: 'off', redirect: false, core: false });
  const r = f.run('set-takeover', 'on');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /both DNS listeners must be ready/);
  assert.equal(f.state('dns-takeover'), 'off');
  assert.equal(f.firewall(), '0');
  assert.doesNotMatch(f.calls(), /enable/);
});

test('manual takeover off persists the choice if firewall cleanup needs retry', t => {
  const f = fixture(t, { takeover: 'on', redirect: true, failDisable: true });
  const r = f.run('set-takeover', 'off');
  assert.notEqual(r.status, 0);
  assert.equal(f.state('dns-takeover'), 'off');
  assert.equal(f.state('vpn-compat-state'), 'error');
  assert.equal(f.firewall(), '1');
  assert.match(f.description(), /重定向错误/);
  const retry = f.run('watch');
  assert.notEqual(retry.status, 0);
  assert.doesNotMatch(f.calls(), /enable/);
});

test('failed initial VPN bypass keeps compatibility enabled for watchdog retry', t => {
  const f = fixture(t, { vpn: true, failDisable: true });
  const r = f.run('set-mode', 'on');
  assert.notEqual(r.status, 0);
  assert.equal(f.state('vpn-compat'), 'on');
  assert.equal(f.state('vpn-compat-state'), 'error');
  assert.equal(f.firewall(), '1');
  assert.match(f.description(), /重定向错误/);
});

test('repeated VPN checks do not rebuild an already absent redirect chain', t => {
  const f = fixture(t, { vpn: true, paused: true, redirect: false });
  f.run('start-guard');
  f.run('start-guard');
  assert.equal((f.calls().match(/^disable$/gm) || []).length, 0);
});

test('disabling compatibility restores the saved takeover preference after listener checks', t => {
  const f = fixture(t, { vpn: true, redirect: false });
  const r = f.run('set-mode', 'off');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.state('vpn-compat'), 'off');
  assert.equal(f.state('dns-takeover'), 'on');
  assert.equal(f.firewall(), '1');
  assert.match(f.description(), /DNS 防护运行中/);
});

test('a dead or unready resolver is never reconnected after the stability window', t => {
  const f = fixture(t, { vpn: false, paused: true, redirect: false, core: false });
  for (let i = 0; i < 3; i += 1) assert.equal(f.run('watch').status, 0);
  assert.equal(f.firewall(), '0');
  assert.equal(f.state('vpn-compat-state'), 'resume_wait');
  assert.doesNotMatch(f.calls(), /enable/);
  assert.match(f.description(), /未就绪/);
});

test('failed auto-resume never advertises active DNS protection', t => {
  const f = fixture(t, { vpn: false, paused: true, redirect: false, failEnable: true });
  for (let i = 0; i < 3; i += 1) f.run('watch');
  assert.equal(f.firewall(), '0');
  assert.equal(f.state('vpn-compat-state'), 'error');
  assert.match(f.description(), /重定向错误/);
});

test('unchanged VPN polls do not rewrite the manager description', t => {
  const f = fixture(t, { vpn: true, paused: false });
  for (let i = 0; i < 3; i += 1) assert.equal(f.run('watch').status, 0);
  assert.match(f.description(), /VPN 旁路/);
  assert.equal(f.descriptionCalls().trim().split('\n').length, 1);
});

test('manager description failure never changes DNS transition success', t => {
  const f = fixture(t, { vpn: false, paused: true, redirect: false, failDescription: true });
  for (let i = 0; i < 3; i += 1) assert.equal(f.run('watch').status, 0);
  assert.equal(f.firewall(), '1');
  assert.equal(f.state('vpn-compat-state'), '');
});

test('missing compatibility setting preserves legacy behavior and never auto-mutates redirects', t => {
  const f = fixture(t, { vpn: true, paused: false, compat: null, redirect: true });
  const r = f.run('watch');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.firewall(), '1');
  assert.equal(f.state('vpn-compat-state'), '');
  assert.equal(f.calls(), '');
});

test('scope refresh rebuilds active redirects without changing saved preferences', t => {
  const f = fixture(t), result = f.run('refresh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls(), 'enable\n');
  assert.equal(f.state('dns-takeover'), 'on');
  assert.equal(f.state('vpn-compat'), 'on');
  assert.equal(result.stderr, '', 'readonly settings must not be sourced repeatedly');
  assert.match(result.stdout, /无需更新订阅规则/);
});

for (const options of [{ takeover: 'off' }, { firewallEnabled: 'false' }, { disabled: true }, { core: false }]) {
  test('scope refresh saves settings without resuming inactive DNS: ' + JSON.stringify(options), t => {
    const f = fixture(t, options), result = f.run('refresh');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.firewall(), '0');
    assert.equal(f.calls(), 'disable\n');
    assert.equal(f.state('dns-takeover'), options.takeover || 'on');
    assert.match(result.stdout, /当前未启用 DNS 重定向/);
  });
}

for (const options of [{ takeover: 'invalid' }, { firewallEnabled: 'invalid' }, { takeover: 'off', failDisable: true }]) {
  test('scope refresh does not treat invalid intent or failed cleanup as success: ' + JSON.stringify(options), t => {
    const f = fixture(t, options), result = f.run('refresh');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /enable/);
    assert.match(f.description(), /重定向错误/);
  });
}

for (const [options, expected] of [[{ vpn: true }, 'vpn'], [{ netReadable: false }, 'unknown'],
  [{ paused: true, redirect: false }, 'resume_wait'], [{ paused: true, redirect: true }, 'resume_wait']]) {
  test('scope refresh respects VPN bypass/recovery: ' + expected, t => {
    const f = fixture(t, options), result = f.run('refresh');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.firewall(), '0');
    assert.doesNotMatch(f.calls(), /enable/);
    assert.equal(f.state('vpn-compat-state'), expected);
    assert.equal(f.state('dns-takeover'), 'on');
    assert.equal(f.state('vpn-compat'), 'on');
    assert.match(result.stdout, /暂不接管 DNS/);
  });
}

test('scope refresh leaves redirects off when installing the new rules fails', t => {
  const f = fixture(t, { failEnable: true }), result = f.run('refresh');
  assert.notEqual(result.status, 0);
  assert.equal(f.firewall(), '0');
  assert.equal(f.calls(), 'enable\ndisable\n');
  assert.equal(f.state('vpn-compat-state'), 'error');
  assert.equal(f.state('dns-takeover'), 'on');
  assert.match(f.description(), /重定向错误/);
});

for (const firewallEnabled of ['false', 'invalid']) test('VPN disconnect does not override disabled/invalid firewall settings: ' + firewallEnabled, t => {
  const f = fixture(t, { paused: true, redirect: false, firewallEnabled });
  for (let i = 0; i < 3; i += 1) assert.equal(f.run('watch').status, 0);
  assert.equal(f.firewall(), '0');
  assert.doesNotMatch(f.calls(), /enable/);
  assert.equal(f.state('dns-takeover'), 'on');
  assert.equal(f.state('vpn-compat'), 'on');
  if (firewallEnabled === 'false') assert.match(f.description(), /接管关闭/);
  else assert.match(f.description(), /重定向错误/);
});
