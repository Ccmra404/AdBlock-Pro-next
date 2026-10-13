import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';

const original = readFileSync(new URL('../scripts/iptables.sh', import.meta.url), 'utf8');
const mock = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "const file = process.env.FIREWALL_TEST_STATE;",
  "const data = JSON.parse(fs.readFileSync(file, 'utf8'));",
  "const ipv6 = /[\\\\/]ip6tables$/.test(process.argv[1]);",
  "if (process.env.FAIL_IP6_BACKEND === '1' && ipv6) { console.error(\"ip6tables: can't initialize ip6tables table `nat': Table does not exist (do you need to insmod?)\"); process.exit(3); }",
  "let args = process.argv.slice(2);",
  "if (args[0] === '-w') args = args.slice(2);",
  "let table = 'filter';",
  "if (args[0] === '-t') { table = args[1]; args = args.slice(2); }",
  "const action = args.shift(), chain = args.shift();",
  "if (process.env.CHECK_RESULT && action === '-C') process.exit(Number(process.env.CHECK_RESULT));",
  "if (process.env.QUERY_RESULT && action === '-S' && (!process.env.QUERY_IPV6_ONLY || ipv6)) process.exit(Number(process.env.QUERY_RESULT));",
  "if (process.env.FAIL_IP6_PROBE === '1' && ipv6 && action === '-L') process.exit(1);",
  "if (process.env.FAIL_CHAIN_LOOKUP === '1' && action === '-L' && chain !== 'OUTPUT') process.exit(1);",
  "const key = table + ':' + chain;",
  "const rule = args.join(' ');",
  "const ok = () => { fs.writeFileSync(file, JSON.stringify(data)); process.exit(0); };",
  "const fail = () => process.exit(1);",
  "if (action === '-L' && !chain) ok();",
  "if (action === '-N') { if (data[key]) fail(); data[key] = []; ok(); }",
  "if (action === '-L') { if (!data[key]) fail(); ok(); }",
  "if (action === '-S') {",
  "  if (!data[key]) fail();",
  "  if (process.env.INVALID_SNAPSHOT === '1') { console.log('unparseable response'); ok(); }",
  "  if (process.env.EMPTY_SNAPSHOT !== '1') console.log('-P ' + chain + ' ACCEPT\\n' + data[key].map(r => '-A ' + chain + ' ' + r).join('\\n'));",
  "  ok();",
  "}",
  "if (action === '-C') { if (!data[key] || !data[key].includes(rule)) fail(); ok(); }",
  "if (action === '-F') { if (!data[key]) fail(); data[key] = []; ok(); }",
  "if (action === '-X') {",
  "  if (!data[key]) fail();",
  "  if (Object.values(data).some(r => r.some(line => ['-j ', '-g ', '--jump ', '--goto '].some(flag => line === flag + chain || line.endsWith(' ' + flag + chain))))) fail();",
  "  delete data[key]; ok();",
  "}",
  "if (action === '-A' || action === '-I') {",
  "  if (!data[key]) fail();",
  "  if (process.env.FAIL_TCP === '1' && chain === 'ADGUARD_REDIRECT_DNS' && rule.includes('-p tcp')) fail();",
  "  if (action === '-A') data[key].push(rule); else data[key].unshift(rule);",
  "  ok();",
  "}",
  "if (action === '-D') {",
  "  if (process.env.DELETE_RESULT) process.exit(Number(process.env.DELETE_RESULT));",
  "  if (process.env.DELETE_NOOP === '1') ok();",
  "  if (!data[key]) fail();",
  "  const i = data[key].indexOf(rule); if (i < 0) fail();",
  "  data[key].splice(i, 1); ok();",
  "}",
  "fail();",
].join('\n') + '\n';

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-firewall-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = {
    'nat:OUTPUT': [], 'nat:PREROUTING': [],
    'filter:OUTPUT': [], 'filter:PREROUTING': [],
  };
  const stateFile = path.join(dir, 'firewall.json');
  writeFileSync(stateFile, JSON.stringify(config));
  const executable = path.join(dir, 'iptables');
  writeFileSync(executable, mock);
  chmodSync(executable, 0o755);
  const ip6 = path.join(dir, 'ip6tables');
  copyFileSync(executable, ip6);
  chmodSync(ip6, 0o755);
  const wrapper = path.join(dir, 'run.sh');
  writeFileSync(wrapper, [
    '#!/usr/bin/env bash',
    'adg_user=root',
    'adg_group=net_raw',
    'redir_port=5591',
    'enable_ipv6_dns=false',
    'block_ipv6_dns=false',
    'ignore_dest_list=""',
    'ignore_src_list=""',
    'log() { :; }',
    original.replace(/^#![^\n]*\n/, '')
      .replace(/^\. \/data\/adb\/adblockpro\/(?:settings.conf|scripts\/base.sh)\r?$/gm, ''),
  ].join('\n'));
  function run(command, extraEnv = {}) {
    return spawnSync('bash', [shellPath(wrapper), command], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
        FIREWALL_TEST_STATE: stateFile, ...overrides, ...extraEnv },
    });
  }
  return {
    run,
    read: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    write: obj => writeFileSync(stateFile, JSON.stringify(obj)),
  };
}
const jump = '-j ADGUARD_REDIRECT_DNS';

test('read-only status distinguishes present and confirmed absent without changing rules', t => {
  const f = fixture(t);
  const absent = f.run('status');
  assert.equal(absent.status, 1);
  assert.equal(absent.stdout.trim(), 'absent');
  assert.equal(f.run('enable').status, 0);
  const before = f.read();
  const r = f.run('status', { CHECK_RESULT: '2' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'present');
  assert.deepEqual(f.read(), before);
});

for (const env of [{ QUERY_RESULT: '1' }, { QUERY_RESULT: '2' }, { EMPTY_SNAPSHOT: '1' }, { INVALID_SNAPSHOT: '1' }]) {
  test('read-only status reports unknown on unreliable snapshots: ' + JSON.stringify(env), t => {
    const f = fixture(t);
    const r = f.run('status', env);
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), 'unknown');
  });
}

test('read-only status accepts explicitly unsupported IPv6 tables but not unknown ones', t => {
  const f = fixture(t);
  assert.equal(f.run('status', { FAIL_IP6_BACKEND: '1' }).status, 1);
  assert.equal(f.run('status', { QUERY_IPV6_ONLY: '1', QUERY_RESULT: '1' }).status, 2);
});

test('read-only status detects legacy IPv6 jumps with default IPv6 takeover disabled', t => {
  const f = fixture(t);
  const before = f.read();
  before['nat:OUTPUT'] = ['-g ADGUARD_REDIRECT_DNS6'];
  before['filter:OUTPUT'] = ['-j ADGUARD_BLOCK_DNS'];
  f.write(before);
  assert.equal(f.run('status').status, 0);
  assert.deepEqual(f.read(), before);
});

test('a visible IPv4 redirect takes precedence over unknown IPv6 state', t => {
  const f = fixture(t);
  const before = f.read();
  before['nat:OUTPUT'] = [jump];
  f.write(before);
  assert.equal(f.run('status', { QUERY_IPV6_ONLY: '1', QUERY_RESULT: '2' }).status, 0);
});

test('enable creates complete IPv4 redirect rules', t => {
  const f = fixture(t);
  const r = f.run('enable');
  assert.equal(r.status, 0, r.stderr);
  const s = f.read();
  assert.equal(s['nat:OUTPUT'].filter(x => x === jump).length, 1);
  assert.equal(s['nat:ADGUARD_REDIRECT_DNS'].length, 3);
  assert(s['nat:ADGUARD_REDIRECT_DNS'].some(x => x.includes('-p udp')));
  assert(s['nat:ADGUARD_REDIRECT_DNS'].some(x => x.includes('-p tcp')));
});

test('repeated enable repairs incomplete chain and never duplicates jump', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const s = f.read();
  s['nat:ADGUARD_REDIRECT_DNS'].pop();
  f.write(s);
  assert.equal(f.run('enable').status, 0);
  const repaired = f.read();
  assert.equal(repaired['nat:OUTPUT'].filter(x => x === jump).length, 1);
  assert.equal(repaired['nat:ADGUARD_REDIRECT_DNS'].length, 3);
});

test('disable removes duplicate legacy jumps and owned chain', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const s = f.read();
  s['nat:OUTPUT'].push(jump);
  f.write(s);
  assert.equal(f.run('disable').status, 0);
  const cleaned = f.read();
  assert.equal(cleaned['nat:OUTPUT'].filter(x => x === jump).length, 0);
  assert.equal(cleaned['nat:ADGUARD_REDIRECT_DNS'], undefined);
});

test('failed rule installation leaves no active DNS redirection', t => {
  const f = fixture(t);
  const r = f.run('enable', { FAIL_TCP: '1' });
  assert.notEqual(r.status, 0);
  const s = f.read();
  assert.equal(s['nat:OUTPUT'].filter(x => x === jump).length, 0);
  assert.equal(s['nat:ADGUARD_REDIRECT_DNS'], undefined);
});


test('no IPv6 iptables backend does not disable default IPv4-only DNS takeover', t => {
  const f = fixture(t, { FAIL_IP6_BACKEND: '1' });
  const start = f.run('enable');
  assert.equal(start.status, 0, start.stderr);
  assert.equal(f.read()['nat:OUTPUT'].filter(x => x === jump).length, 1);
  const stop = f.run('disable');
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(f.read()['nat:ADGUARD_REDIRECT_DNS'], undefined);
});


test('legacy IPv6 jumps are cleaned when the backend is available without enabling IPv6', t => {
  const f = fixture(t);
  const before = f.read();
  before['nat:OUTPUT'] = ['-j ADGUARD_REDIRECT_DNS6', '-j ADGUARD_REDIRECT_DNS6'];
  before['nat:ADGUARD_REDIRECT_DNS6'] = ['legacy'];
  before['filter:OUTPUT'] = ['-j ADGUARD_BLOCK_DNS'];
  before['filter:ADGUARD_BLOCK_DNS'] = ['legacy'];
  f.write(before);
  assert.equal(f.run('enable').status, 0);
  const after = f.read();
  assert.deepEqual(after['nat:OUTPUT'], [jump]);
  assert.deepEqual(after['filter:OUTPUT'], []);
  assert.equal(after['nat:ADGUARD_REDIRECT_DNS6'], undefined);
});

for (const code of ['1', '2']) test('snapshot query error ' + code + ' must not claim successful cleanup', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const result = f.run('disable', { CHECK_RESULT: '1', QUERY_RESULT: code, FAIL_CHAIN_LOOKUP: '1' });
  assert.notEqual(result.status, 0);
  assert(f.read()['nat:OUTPUT'].includes(jump));
});

test('-C exit 1 cannot hide a jump visible in a successful snapshot', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const result = f.run('disable', { CHECK_RESULT: '1', DELETE_RESULT: '1' });
  assert.notEqual(result.status, 0);
  assert(f.read()['nat:OUTPUT'].includes(jump));
});

test('successful snapshots remove visible jumps even if -C is broken', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  assert.equal(f.run('disable', { CHECK_RESULT: '1' }).status, 0);
  assert.deepEqual(f.read()['nat:OUTPUT'], []);
});

for (const flag of ['EMPTY_SNAPSHOT', 'INVALID_SNAPSHOT']) test(flag + ' is unknown rather than absent', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  assert.notEqual(f.run('disable', { [flag]: '1' }).status, 0);
  assert(f.read()['nat:OUTPUT'].includes(jump));
});

test('a deletion reported as successful must actually reduce residual jumps', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const result = f.run('disable', { CHECK_RESULT: '1', DELETE_NOOP: '1' });
  assert.notEqual(result.status, 0);
  assert(f.read()['nat:OUTPUT'].includes(jump));
});

test('IPv6 query failure is not evidence of an unsupported backend', t => {
  const f = fixture(t);
  const s = f.read();
  s['nat:OUTPUT'] = ['-j ADGUARD_REDIRECT_DNS6'];
  s['nat:ADGUARD_REDIRECT_DNS6'] = ['legacy'];
  f.write(s);
  assert.notEqual(f.run('disable', { CHECK_RESULT: '1', QUERY_RESULT: '1', QUERY_IPV6_ONLY: '1', FAIL_IP6_PROBE: '1' }).status, 0);
  assert(f.read()['nat:OUTPUT'].includes('-j ADGUARD_REDIRECT_DNS6'));
});

test('cleanup preserves unrelated rules and ignores jump text inside quoted comments', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const s = f.read();
  const unrelated = '-m comment --comment "text -j ADGUARD_REDIRECT_DNS" -j RETURN';
  s['nat:OUTPUT'].push(unrelated, '-j ADGUARD_REDIRECT_DNS_OTHER');
  f.write(s);
  assert.equal(f.run('disable').status, 0);
  assert.deepEqual(f.read()['nat:OUTPUT'], [unrelated, '-j ADGUARD_REDIRECT_DNS_OTHER']);
});

for (const residual of ['-p udp -j ADGUARD_REDIRECT_DNS', '-g ADGUARD_REDIRECT_DNS']) {
  test('unexpected owned reference requires recovery instead of deleting another rule: ' + residual, t => {
    const f = fixture(t);
    assert.equal(f.run('enable').status, 0);
    const s = f.read();
    s['nat:OUTPUT'].push(residual);
    f.write(s);
    assert.notEqual(f.run('disable').status, 0);
    assert(f.read()['nat:OUTPUT'].includes(residual));
    assert(f.read()['nat:ADGUARD_REDIRECT_DNS'].length > 0);
  });
}
