import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const source = readFileSync(new URL('../scripts/network-diagnostics.sh', import.meta.url), 'utf8');
const currentNetworks = (transport = 'WIFI', extra = '') => `Current Networks:
  NetworkAgentInfo{network{100} ni{WIFI CONNECTED} nc{[ Transports: ${transport} Capabilities: INTERNET&NOT_VPN]} ${extra}}
    Requests: REQUEST:1 LISTEN:0
Status for known UIDs:
Network Requests:
  NetworkRequest [ Transports: VPN Capabilities: INTERNET ]
Network Logs:
  NetworkAgentInfo{nc{[ Transports: VPN Capabilities: INTERNET]}}
`;
const ipv6Snapshot = `diag_ipv6_mode=disabled
diag_ipv6_nat_table=readable
diag_ipv6_redirect=absent
diag_ipv6_filter_table=readable
diag_ipv6_block=absent
`;

function fixture(t) {
  const f = rootFixture(t); f.addBusybox('Magisk');
  // Model BusyBox applet dispatch; inject timeout exits without sleeping.
  const busybox = f.paths.Magisk;
  writeFileSync(busybox, readFileSync(busybox, 'utf8').replace('case "$1" in', `case "$1" in
  timeout) shift; limit=$1; shift
    printf '%s\\n' "timeout $limit $1" >> "$QUERY_TRACE"
    [ "$TIMEOUT_KIND" != "$1" ] || exit 124
    [ "$TIMEOUT_IPV6:$limit" != 1:6 ] || exit 124
    exec "$@" ;;
`));
  const runtime = path.join(f.dir, 'runtime'), bin = path.join(f.dir, 'mock-bin');
  mkdirSync(path.join(runtime, 'scripts'), { recursive: true });
  mkdirSync(bin);
  const entry = path.join(f.dir, 'scripts/network-diagnostics.sh');
  writeFileSync(entry, source);
  const vpnFile = path.join(f.dir, 'connectivity.txt'), ipv6File = path.join(f.dir, 'ipv6.txt');
  const trace = path.join(f.dir, 'queries.txt');
  writeFileSync(vpnFile, currentNetworks()); writeFileSync(ipv6File, ipv6Snapshot);
  function command(name, body) {
    const file = path.join(bin, name); writeFileSync(file, '#!/bin/sh\n' + body); chmodSync(file, 0o755);
  }
  command('settings', `printf '%s\\n' "settings $*" >> "$QUERY_TRACE"
[ "$1:$2" = get:global ] || exit 77
[ "$FAIL_SETTING" != "$3" ] || exit 1
case "$3" in
  private_dns_mode) printf '%s\\n' "\${PRIVATE_MODE-null}" ;;
  private_dns_default_mode) printf '%s\\n' "\${PRIVATE_DEFAULT-null}" ;;
  http_proxy) printf '%s\\n' "\${HTTP_PROXY_SETTING-null}" ;;
  global_http_proxy_host) printf '%s\\n' "\${PROXY_HOST-null}" ;;
  global_proxy_pac_url) printf '%s\\n' "\${PROXY_PAC-null}" ;;
  *) exit 77 ;;
esac
`);
  command('dumpsys', 'printf \'%s\\n\' "dumpsys $*" >> "$QUERY_TRACE"\n[ "$*" = "connectivity --short" ] || exit 77\n[ "$FAIL_VPN" != 1 ] || exit 1\ncat "$VPN_FILE"\n');
  writeFileSync(path.join(runtime, 'scripts/iptables.sh'), '#!/bin/sh\n[ "$1" = diagnose-ipv6 ] || exit 77\n[ "$FAIL_IPV6" != 1 ] || exit 1\ncat "$IPV6_FILE"\n');
  return {
    vpn: text => writeFileSync(vpnFile, text), ipv6: text => writeFileSync(ipv6File, text),
    run(extra = {}) {
      const r = spawnSync('bash', [shellPath(entry)], { timeout: 10000, encoding: 'utf8', env: {
        ...f.env('Magisk'), PATH: bin + path.delimiter + process.env.PATH,
        ABP_AGH_DIR: shellPath(runtime), QUERY_TRACE: shellPath(trace), VPN_FILE: shellPath(vpnFile), IPV6_FILE: shellPath(ipv6File), ...extra,
      } });
      assert.equal(r.status, 0, r.stderr);
      const data = Object.fromEntries(r.stdout.split('\n').filter(x => x.startsWith('diag_')).map(x => x.split('=')));
      return { ...data, text: r.stdout, queries: readFileSync(trace, 'utf8') };
    },
  };
}

test('diagnosis reads current settings and ignores VPN text in requests/history', t => {
  const result = fixture(t).run({ PRIVATE_MODE: 'off' });
  assert.equal(result.diag_private_dns, 'off');
  assert.equal(result.diag_global_http_proxy, 'not_configured');
  assert.equal(result.diag_vpn, 'not_detected');
  assert.equal(result.diag_ipv6_mode, 'disabled');
  assert.match(result.text, /配置：未启用；NAT 表：可读取/);
  assert.match(result.queries, /timeout 2 settings/);
  assert.match(result.queries, /timeout 3 dumpsys/);
  assert.match(result.queries, /timeout 6 /);
  assert.doesNotMatch(result.queries, /settings (put|delete)|--diag/);
});

test('registered VPN is detected only in a recognised current network entry', t => {
  const f = fixture(t); f.vpn(currentNetworks('WIFI|VPN'));
  assert.equal(f.run().diag_vpn, 'detected');
});

for (const snapshot of ['', 'Permission Denial: private-provider-secret\n',
  'Current Networks:\n  NetworkAgentInfo{nc{[ Transports: VPN ]}}\n',
  'Current Networks:\n  changed-format\nStatus for known UIDs:\n',
  'Current Networks:\n  NetworkAgentInfo{nc{[ Transports: 123 ]}}\nStatus for known UIDs:\n',
  'Current Networks:\n  NetworkAgentInfo{changed-format}\nStatus for known UIDs:\n']) {
  test('unreadable or incomplete VPN snapshot remains unknown: ' + JSON.stringify(snapshot.slice(0, 35)), t => {
    const f = fixture(t); f.vpn(snapshot);
    const result = f.run(); assert.equal(result.diag_vpn, 'unknown');
    assert.doesNotMatch(result.text, /private-provider-secret|Permission Denial|changed-format/);
  });
}

for (const [options, expected] of [
  [{ PRIVATE_MODE: 'hostname' }, 'hostname'],
  [{ PRIVATE_MODE: 'opportunistic' }, 'opportunistic'],
  [{ PRIVATE_DEFAULT: 'off' }, 'off'],
  [{}, 'system_default'],
  [{ PRIVATE_MODE: '' }, 'unknown'],
  [{ PRIVATE_MODE: 'unexpected-mode' }, 'unknown'],
  [{ FAIL_SETTING: 'private_dns_default_mode' }, 'unknown'],
]) test('private DNS configuration is not confused with a validated encrypted route: ' + JSON.stringify(options), t => {
  assert.equal(fixture(t).run(options).diag_private_dns, expected);
});

for (const options of [
  { HTTP_PROXY_SETTING: '127.0.0.1:7890' }, { HTTP_PROXY_SETTING: '[::1]:7890' },
  { PROXY_HOST: 'private-proxy.example' }, { PROXY_PAC: 'https://private-pac.example/token-secret' },
]) test('configured global proxy is reported without its endpoint: ' + JSON.stringify(Object.keys(options)), t => {
  const result = fixture(t).run(options);
  assert.equal(result.diag_global_http_proxy, 'configured');
  assert.doesNotMatch(result.text, /127\.0\.0\.1|7890|::1|private-proxy|private-pac|token-secret/);
});

test('failed settings reads are unknown, while positive proxy evidence survives a partial failure', t => {
  const f = fixture(t);
  assert.equal(f.run({ FAIL_SETTING: 'http_proxy' }).diag_global_http_proxy, 'unknown');
  assert.equal(f.run({ FAIL_SETTING: 'http_proxy', PROXY_HOST: 'localhost' }).diag_global_http_proxy, 'configured');
  assert.equal(f.run({ HTTP_PROXY_SETTING: ':0' }).diag_global_http_proxy, 'not_configured');
  assert.equal(f.run({ HTTP_PROXY_SETTING: 'Permission Denial' }).diag_global_http_proxy, 'unknown');
  assert.equal(f.run({ HTTP_PROXY_SETTING: 'Permission Denial\n127.0.0.1:7890' }).diag_global_http_proxy, 'unknown');
});

for (const [kind, fields] of [['settings', ['diag_private_dns', 'diag_global_http_proxy']], ['dumpsys', ['diag_vpn']]]) {
  test('timed out system query stays unknown: ' + kind, t => {
    const result = fixture(t).run({ TIMEOUT_KIND: kind });
    for (const key of fields) assert.equal(result[key], 'unknown');
  });
}

test('missing, malformed or duplicated IPv6 results cannot become disabled/absent', t => {
  const f = fixture(t);
  assert.equal(f.run({ FAIL_IPV6: '1' }).diag_ipv6_mode, 'unknown');
  assert.equal(f.run({ TIMEOUT_IPV6: '1' }).diag_ipv6_mode, 'unknown');
  f.ipv6(''); assert.equal(f.run().diag_ipv6_redirect, 'unknown');
  f.ipv6('diag_ipv6_redirect=absent=malformed\n'); assert.equal(f.run().diag_ipv6_redirect, 'unknown');
  f.ipv6(ipv6Snapshot + 'diag_ipv6_redirect=present\n');
  assert.equal(f.run().diag_ipv6_redirect, 'unknown');
});

test('disabled IPv6 preference does not hide a residual module jump', t => {
  const f = fixture(t); f.ipv6(ipv6Snapshot.replace('diag_ipv6_redirect=absent', 'diag_ipv6_redirect=present'));
  assert.match(f.run().text, /未启用，但仍发现本模块 IPv6 跳转/);
});
