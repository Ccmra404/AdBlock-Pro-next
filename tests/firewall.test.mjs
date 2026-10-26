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
  "  if (process.env.FAIL_VPN_MARK === '1' && rule.includes('--mark')) fail();",
  "  if (process.env.FAIL_TCP === '1' && chain === 'ADGUARD_REDIRECT_DNS' && rule.includes('-p tcp')) fail();",
  "  if ((process.env.FAIL_APP_RULE === '1' || (process.env.FAIL_IP6_APP_RULE === '1' && ipv6)) && /--uid-owner [0-9]+ -j RETURN/.test(rule)) fail();",
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
  const excluded = path.join(dir, 'app-exclusions.txt');
  const helper = path.join(dir, 'app-filter');
  const lookups = path.join(dir, 'app-lookups');
  const busybox = path.join(dir, 'busybox');
  writeFileSync(busybox, '#!/bin/sh\nexec "$@"\n');
  chmodSync(busybox, 0o755);
  writeFileSync(helper, '#!/bin/sh\n[ "$1" = uids ] || exit 2\nprintf "lookup\\n" >> "$APP_LOOKUPS"\n[ "$FAIL_UID_LOOKUP" != 1 ] || exit 1\nprintf "%s" "$TEST_APP_UIDS"\n');
  chmodSync(helper, 0o755);
  const wrapper = path.join(dir, 'run.sh');
  writeFileSync(wrapper, [
    '#!/usr/bin/env bash',
    'adg_user=root',
    'adg_group=net_raw',
    'redir_port=5591',
    'enable_ipv6_dns=${TEST_IPV6_ENABLED:-false}',
    'block_ipv6_dns=${TEST_IPV6_BLOCK:-false}',
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
        FIREWALL_TEST_STATE: stateFile, BB: shellPath(busybox), ABP_APP_FILTER: shellPath(helper),
        ABP_APP_EXCLUSIONS: shellPath(excluded), APP_LOOKUPS: shellPath(lookups),
        ...overrides, ...extraEnv },
    });
  }
  return {
    run,
    exclude: () => writeFileSync(excluded, '0:com.example.excluded\n'),
    lookups: () => { try { return readFileSync(lookups, 'utf8'); } catch { return ''; } },
    read: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    write: obj => writeFileSync(stateFile, JSON.stringify(obj)),
  };
}
const jump = '-j ADGUARD_REDIRECT_DNS';

for (const [options, expected] of [[{}, 'disabled'], [{ TEST_IPV6_ENABLED: 'true' }, 'redirect'],
  [{ TEST_IPV6_ENABLED: 'true', TEST_IPV6_BLOCK: 'true' }, 'block'], [{ TEST_IPV6_ENABLED: 'invalid' }, 'unknown']]) {
  test('IPv6 diagnosis distinguishes preference from actual owned jumps: ' + expected, t => {
    const f = fixture(t); f.write({ 'nat:OUTPUT': ['-j ADGUARD_REDIRECT_DNS6'], 'filter:OUTPUT': [] });
    const before = f.read(), result = f.run('diagnose-ipv6', options);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp('diag_ipv6_mode=' + expected + '\\n'));
    assert.match(result.stdout, /diag_ipv6_nat_table=readable\ndiag_ipv6_redirect=present/);
    assert.match(result.stdout, /diag_ipv6_filter_table=readable\ndiag_ipv6_block=absent/);
    assert.deepEqual(f.read(), before);
  });
}

for (const [env, expected] of [[{ FAIL_IP6_BACKEND: '1' }, 'unsupported'], [{ QUERY_RESULT: '2' }, 'unknown'],
  [{ EMPTY_SNAPSHOT: '1' }, 'unknown'], [{ INVALID_SNAPSHOT: '1' }, 'unknown']]) {
  test('IPv6 diagnosis distinguishes explicit table absence from query failure: ' + JSON.stringify(env), t => {
    const f = fixture(t), before = f.read(), result = f.run('diagnose-ipv6', env);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp('diag_ipv6_nat_table=' + expected + '\\n'));
    assert.match(result.stdout, new RegExp('diag_ipv6_redirect=' + expected + '\\n'));
    assert.deepEqual(f.read(), before);
  });
}

test('IPv4 status does not mistake a legacy IPv6 jump for IPv4 takeover', t => {
  const f = fixture(t);
  f.write({ 'nat:OUTPUT': ['-j ADGUARD_REDIRECT_DNS6'], 'filter:OUTPUT': [] });
  assert.equal(f.run('status').stdout.trim(), 'present');
  const before = f.read();
  const result = f.run('status-ipv4', { QUERY_RESULT: '2', QUERY_IPV6_ONLY: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), 'absent');
  assert.deepEqual(f.read(), before);
});

for (const env of [{ QUERY_RESULT: '1' }, { QUERY_RESULT: '2' }, { EMPTY_SNAPSHOT: '1' }, { INVALID_SNAPSHOT: '1' }]) {
  test('IPv4 status keeps failed or malformed queries unknown: ' + JSON.stringify(env), t => {
    const f = fixture(t);
    const result = f.run('status-ipv4', env);
    assert.equal(result.status, 2);
    assert.equal(result.stdout.trim(), 'unknown');
  });
}

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
  assert.equal(s['nat:ADGUARD_REDIRECT_DNS'].length, 4);
  assert(s['nat:ADGUARD_REDIRECT_DNS'].some(x => x.includes('-p udp')));
  assert(s['nat:ADGUARD_REDIRECT_DNS'].some(x => x.includes('-p tcp')));
});

test('default scope does not query Android packages or require the app helper', t => {
  const f = fixture(t), r = f.run('enable', { ABP_APP_FILTER: '/missing/helper' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.lookups(), '');
});

for (const ipv6Mode of ['disabled', 'redirect', 'block']) test('application bypass precedes DNS rules in ' + ipv6Mode + ' mode', t => {
  const f = fixture(t); f.exclude();
  const r = f.run('enable', { TEST_APP_UIDS: '10123\n10124\n',
    TEST_IPV6_ENABLED: ipv6Mode === 'disabled' ? 'false' : 'true', TEST_IPV6_BLOCK: ipv6Mode === 'block' ? 'true' : 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.lookups(), 'lookup\n', 'resolve the same snapshot once across protocol families');
  const state = f.read();
  const chains = ['nat:ADGUARD_REDIRECT_DNS'];
  if (ipv6Mode === 'redirect') chains.push('nat:ADGUARD_REDIRECT_DNS6');
  if (ipv6Mode === 'block') chains.push('filter:ADGUARD_BLOCK_DNS');
  for (const chain of chains) {
    const rules = state[chain];
    for (const uid of ['10123', '10124']) {
      const index = rules.indexOf('-m owner --uid-owner ' + uid + ' -j RETURN');
      assert(index >= 0, chain + ' missing app bypass');
      assert(index < rules.findIndex(rule => rule.includes('-p udp')), chain + ' UDP bypass order');
      assert(index < rules.findIndex(rule => rule.includes('-p tcp')), chain + ' TCP bypass order');
    }
    if (chain.startsWith('nat:')) assert.equal(rules[0], '-m owner --uid-owner root --gid-owner net_raw -j RETURN');
  }
});

for (const env of [{ FAIL_UID_LOOKUP: '1' }, { TEST_APP_UIDS: '10123\n--jump DROP\n' },
  { TEST_APP_UIDS: '4294967295\n' }, { ABP_APP_FILTER: '/missing/helper' }]) {
  test('invalid or unavailable app identities preserve the installed firewall: ' + JSON.stringify(env), t => {
    const f = fixture(t); assert.equal(f.run('enable').status, 0); f.exclude();
    const before = f.read(), r = f.run('enable', env);
    assert.notEqual(r.status, 0);
    assert.deepEqual(f.read(), before);
  });
}

test('removed packages yield no stale numeric UID bypass', t => {
  const f = fixture(t); f.exclude();
  assert.equal(f.run('enable', { TEST_APP_UIDS: '10123\n' }).status, 0);
  const r = f.run('enable', { TEST_APP_UIDS: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read()['nat:ADGUARD_REDIRECT_DNS'].length, 3);
});

for (const env of [{ FAIL_APP_RULE: '1' }, { FAIL_IP6_APP_RULE: '1', TEST_IPV6_ENABLED: 'true' },
  { FAIL_IP6_APP_RULE: '1', TEST_IPV6_ENABLED: 'true', TEST_IPV6_BLOCK: 'true' }]) {
  test('app bypass installation failure leaves no partial DNS takeover: ' + JSON.stringify(env), t => {
    const f = fixture(t); f.exclude();
    const r = f.run('enable', { TEST_APP_UIDS: '10123\n', ...env });
    assert.notEqual(r.status, 0);
    const state = f.read();
    assert.deepEqual(state['nat:OUTPUT'], []);
    assert.deepEqual(state['filter:OUTPUT'], []);
  });
}

test('repeated enable repairs incomplete chain and never duplicates jump', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const s = f.read();
  s['nat:ADGUARD_REDIRECT_DNS'].pop();
  f.write(s);
  assert.equal(f.run('enable').status, 0);
  const repaired = f.read();
  assert.equal(repaired['nat:OUTPUT'].filter(x => x === jump).length, 1);
  assert.equal(repaired['nat:ADGUARD_REDIRECT_DNS'].length, 4);
});

test('VPN-protected app DNS is exempt before ordinary DNS redirection', t => {
  const f = fixture(t);
  assert.equal(f.run('enable').status, 0);
  const rules = f.read()['nat:ADGUARD_REDIRECT_DNS'];
  const bypass = rules.indexOf('-m mark --mark 0x20000/0xe0000 -j RETURN');
  assert(bypass >= 0, 'honor protectedFromVpn only when permission bits are NONE');
  assert(bypass < rules.findIndex(rule => rule.includes('-j REDIRECT')));
  assert(rules.some(rule => rule.includes('--uid-owner root --gid-owner net_raw')));
  assert.equal(rules.filter(rule => rule.includes('-j REDIRECT')).length, 2);
  assert(!rules.some(rule => rule.includes('198.18.0.2')), 'ordinary VPN DNS must still reach AGH');
});

test('an unavailable VPN mark matcher leaves no partial active redirection', t => {
  const f = fixture(t);
  assert.notEqual(f.run('enable', { FAIL_VPN_MARK: '1' }).status, 0);
  assert.deepEqual(f.read()['nat:OUTPUT'], []);
  assert.equal(f.read()['nat:ADGUARD_REDIRECT_DNS'], undefined);
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
