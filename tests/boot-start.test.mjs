import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';

const source = readFileSync(new URL('../service.sh', import.meta.url), 'utf8');
const start = source.indexOf('boot_route_ready() {');
const end = source.indexOf('# Start the module enable/disable watcher', start);
assert(start >= 0 && end > start, 'boot readiness helpers exist');
const helperCode = source.slice(start, end);

function run(t, action, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ip = path.join(dir, 'ip');
  writeFileSync(ip, [
    '#!/bin/sh',
    'case "$1" in',
    '  -4) printf "%s\\n" "$MOCK_IPV4_ROUTE" ;;',
    '  -6) printf "%s\\n" "$MOCK_IPV6_ROUTE" ;;',
    'esac',
  ].join('\n') + '\n');
  chmodSync(ip, 0o755);
  const body = [
    'boot_network_wait=' + (options.wait ?? 4),
    'sleep() { echo tick >> "$COUNT_FILE"; }',
    helperCode,
    action,
  ].join('\n');
  const countFile = path.join(dir, 'count');
  const result = spawnSync('bash', ['-c', body], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      COUNT_FILE: shellPath(countFile),
      MOCK_IPV4_ROUTE: options.ipv4 || '',
      MOCK_IPV6_ROUTE: options.ipv6 || '',
    },
  });
  return { result, ticks: readCount(countFile) };
}
function readCount(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n').length; }
  catch { return 0; }
}

test('an IPv4 default route indicates network interface readiness', t => {
  const { result, ticks } = run(t, 'wait_for_boot_network', {
    ipv4: 'default via 192.168.1.1 dev wlan0 table wlan0',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ticks, 0);
});

test('an IPv6 default route is also accepted', t => {
  const { result, ticks } = run(t, 'wait_for_boot_network', {
    ipv6: 'default via fe80::123 dev wlan0 table wlan0',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ticks, 0);
});

test('offline boot times out and still permits DNS startup', t => {
  const { result, ticks } = run(t, 'wait_for_boot_network');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ticks, 2);
});

test('waiting can be disabled using zero seconds', t => {
  const { result, ticks } = run(t, 'wait_for_boot_network', { wait: 0 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ticks, 0);
});

test('a local route alone is not mistaken for a usable default route', t => {
  const { result } = run(t, 'boot_route_ready', {
    ipv4: '192.168.1.0/24 dev wlan0 scope link src 192.168.1.25',
  });
  assert.notEqual(result.status, 0);
});
