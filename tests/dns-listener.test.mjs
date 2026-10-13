import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runtime = readFileSync(new URL('../scripts/tool.sh', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');

function extract(source, stop) {
  const first = source.indexOf('is_protocol_listening() {');
  const last = source.indexOf(stop, first);
  assert(first >= 0 && last > first);
  return source.slice(first, last).replaceAll('"$BB" awk', 'awk');
}

const implementations = [
  ['runtime', extract(runtime, '# A live PID')],
  ['dashboard', extract(dashboard, 'is_our_process() {')],
];
function procRow(port, state) {
  return [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid timeout inode',
    '   0: 0100007F:' + port + ' 00000000:0000 ' + state + ' 00000000:00000000 00:00000000 00000000 0 0 12345',
    '',
  ].join('\n');
}
function check(t, implementation, rows, expected) {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-sockets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'proc');
  writeFileSync(file, rows);
  const script = [
    'redir_port=5591',
    implementation,
    'is_protocol_listening "$1" "$2"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script, 'listener-test', file, expected],
    { encoding: 'utf8', timeout: 10000 });
  return r.status;
}

for (const [name, implementation] of implementations) {
  test(name + ': TCP LISTEN is accepted', t => {
    assert.equal(check(t, implementation, procRow('15D7', '0A'), '0A'), 0);
  });
  test(name + ': TCP TIME_WAIT is not considered ready', t => {
    assert.notEqual(check(t, implementation, procRow('15D7', '06'), '0A'), 0);
  });
  test(name + ': matching TCP state on wrong port is rejected', t => {
    assert.notEqual(check(t, implementation, procRow('15D8', '0A'), '0A'), 0);
  });
  test(name + ': UDP UNCONN is accepted', t => {
    assert.equal(check(t, implementation, procRow('15D7', '07'), '07'), 0);
  });
  test(name + ': connected UDP socket is not treated as listener', t => {
    assert.notEqual(check(t, implementation, procRow('15D7', '01'), '07'), 0);
  });
}


test('status and diagnostics supply correct protocol states to listener checks', () => {
  const udpCalls = dashboard.match(/is_protocol_listening '\/proc\/net\/udp \/proc\/net\/udp6' 07 && listening_udp=1/g) || [];
  const tcpCalls = dashboard.match(/is_protocol_listening '\/proc\/net\/tcp \/proc\/net\/tcp6' 0A && listening_tcp=1/g) || [];
  assert.equal(udpCalls.length, 2, 'both status and diagnose must check UDP UNCONN (07)');
  assert.equal(tcpCalls.length, 2, 'both status and diagnose must check TCP LISTEN (0A)');
  assert.doesNotMatch(dashboard, /is_protocol_listening '\/proc\/net\/(?:tcp|udp) \/proc\/net\/(?:tcp6|udp6)' &&/, 'no call site may omit expected state');
});
