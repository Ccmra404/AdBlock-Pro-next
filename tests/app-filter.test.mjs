import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t) {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const state = path.join(root.dir, 'state'), agh = path.join(root.dir, 'agh');
  mkdirSync(state); mkdirSync(path.join(agh, 'scripts'), { recursive: true });
  const script = path.join(agh, 'scripts/app-filter.sh');
  writeFileSync(path.join(agh, 'scripts/compat.sh'), readFileSync(root.compatFile, 'utf8'));
  const bin = path.join(root.dir, 'mock-bin'); mkdirSync(bin);
  const systemBin = path.join(root.dir, 'system/bin'); mkdirSync(systemBin, { recursive: true });
  const tempDir = path.join(root.dir, 'tmp'); mkdirSync(tempDir);
  const systemPm = path.join(systemBin, 'pm');
  const put = (file, content) => { writeFileSync(file, content); chmodSync(file, 0o755); };
  put(path.join(bin, 'pm'), '#!/bin/sh\n[ "${TEST_PM_FAIL:-0}" != 1 ] || exit 1\nif [ "$2" = users ]; then printf "%s\\n" "$TEST_USERS"; exit; fi\ncase "$5" in 0) printf "%s\\n" "$TEST_PACKAGES" ;; 10) printf "%s\\n" "$TEST_PROFILE_PACKAGES" ;; *) exit 1 ;; esac\n');
  put(path.join(systemBin, 'cmd'), '#!/bin/sh\n[ "$1" = package ] || exit 2\nshift\n[ -z "${TEST_SYSTEM_CMD_STDERR:-}" ] || printf "%s\\n" "$TEST_SYSTEM_CMD_STDERR" >&2\n[ "${TEST_SYSTEM_CMD_FAIL:-0}" != 1 ] || { echo "Package Manager backend failed" >&2; exit 1; }\nif [ "$1" = list ] && [ "$2" = users ]; then printf "%s\\n" "$TEST_USERS"; exit; fi\ncase "$5" in 0) printf "%s\\n" "$TEST_PACKAGES" ;; 10) printf "%s\\n" "$TEST_PROFILE_PACKAGES" ;; *) exit 1 ;; esac\n');
  put(systemPm, '#!/bin/sh\ncommand -v cmd >/dev/null 2>&1 || { echo "cmd: inaccessible or not found"; exit 1; }\ncmd package "$@"\n');
  writeFileSync(script, readFileSync(new URL('../scripts/app-filter.sh', import.meta.url), 'utf8')
    .replaceAll('/system/bin', shellPath(systemBin)));
  put(path.join(agh, 'scripts/vpn-compat.sh'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$ABP_STATE_DIR/refresh.trace"\nif [ "${TEST_APPLY_FAIL:-0}" = 1 ] && grep -q "0:com.example.new" "$ABP_STATE_DIR/app-exclusions.txt"; then exit 1; fi\necho "[+] scope refreshed"\n');
  const file = path.join(state, 'app-exclusions.txt');
  const env = { ...root.env('Magisk'), PATH: bin + path.delimiter + process.env.PATH,
    ABP_AGH_DIR: shellPath(agh), ABP_STATE_DIR: shellPath(state),
    ABP_PM_STDERR_DIR: shellPath(tempDir),
    TEST_PACKAGES: 'package:android uid:1000\npackage:com.example.one uid:10123\npackage:com.example.new uid:10456\npackage:com.example.shared uid:10123',
    TEST_PROFILE_PACKAGES: 'package:com.example.one uid:1010123',
    TEST_USERS: 'Users:\n  UserInfo{0:Owner:13} running\n  UserInfo{10:Work:30} running',
  };
  const run = (args, extra = {}) => spawnSync('bash', [shellPath(script), ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...env, ...extra },
  });
  return { root, state, file, run };
}

test('default all-app filtering needs no Package Manager access or state file', t => {
  const f = fixture(t);
  for (const action of ['list', 'uids']) {
    const r = f.run([action], { TEST_PM_FAIL: '1' });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
  }
  assert.equal(existsSync(f.file), false);
});

test('bulk selection validation accepts 512 entries, the largest user ID and a final line without a newline', t => {
  const f = fixture(t);
  const keys = Array.from({ length: 511 }, (_, i) => `0:com.example.app${i}`);
  keys.push('21473:com.example.last');
  writeFileSync(f.file, keys.join('\n'));
  const r = f.run(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, keys.map(key => `excluded\t${key}\n`).join(''));
});

test('bulk selection validation rejects invalid saved entries and does not apply a new scope', t => {
  const f = fixture(t);
  const invalid = ['00:com.example.one', '21474:com.example.one', '99999:com.example.one',
    '0:com.example;id', '0:com..example', `0:com.${'a'.repeat(260)}`, '', '0:com.example.one\r'];
  for (const key of invalid) {
    const original = `0:com.example.one\n${key}\n`;
    writeFileSync(f.file, original);
    const listed = f.run(['list']);
    assert.notEqual(listed.status, 0, key);
    assert.equal(listed.stdout, '');
    assert.notEqual(f.run(['set', '0:com.example.new', 'off']).status, 0, key);
    assert.equal(readFileSync(f.file, 'utf8'), original);
    assert.equal(existsSync(path.join(f.state, 'refresh.trace')), false);
  }
});

test('bulk selection validation rejects more than 512 entries', t => {
  const f = fixture(t);
  writeFileSync(f.file, Array.from({ length: 513 }, (_, i) => `0:com.example.app${i}`).join('\n'));
  const r = f.run(['list']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /最多保存 512 项/);
});

test('resolves installed packages and profiles, deduplicates shared UIDs, skips removed apps', t => {
  const f = fixture(t);
  writeFileSync(f.file, '0:com.example.one\n0:com.example.shared\n0:com.example.removed\n10:com.example.one\n');
  const r = f.run(['uids']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '10123\n1010123\n');
  const changed = f.run(['uids'], { TEST_PACKAGES: 'package:com.example.one uid:10999' });
  assert.equal(changed.status, 0, changed.stderr); assert.equal(changed.stdout, '10999\n1010123\n');
  assert.match(f.run(['list']).stdout, /excluded\t0:com.example.removed/);
});

test('UID lookup calls Android package service directly when detached worker PATH lacks pm and cmd', t => {
  const f = fixture(t); writeFileSync(f.file, '0:com.example.one\n');
  const r = f.run(['uids'], { TEST_PM_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '10123\n');
});

test('keeps successful Package Manager stderr out of captured UID output and removes its temp file', t => {
  const f = fixture(t); writeFileSync(f.file, '0:com.example.one\n');
  const r = f.run(['uids'], { TEST_SYSTEM_CMD_STDERR: 'non-fatal Package Manager warning' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '10123\n');
  assert.equal(r.stderr, '');
  assert.deepEqual(readdirSync(path.join(f.root.dir, 'tmp')), []);
});

for (const output of ['', 'Error: Package manager unavailable', 'package:com.example.one uid:$(touch bad)',
  'package:com.example.one uid:1010123', 'package:com.example.one uid:10123\npackage:com.example.one uid:10124']) {
  test('rejects malformed, conflicting or wrong-user Package Manager output: ' + output, t => {
    const f = fixture(t); writeFileSync(f.file, '0:com.example.one\n');
    assert.notEqual(f.run(['uids'], { TEST_PACKAGES: output }).status, 0);
    assert.equal(readFileSync(f.file, 'utf8'), '0:com.example.one\n');
  });
}

test('toggle preserves hidden selections and applies immediately without subscription commands', t => {
  const f = fixture(t); writeFileSync(f.file, '10:com.example.one\n0:com.example.removed\n');
  const add = f.run(['set', '0:com.example.new', 'off']);
  assert.equal(add.status, 0, add.stderr);
  assert.match(readFileSync(f.file, 'utf8'), /10:com.example.one\n0:com.example.removed\n0:com.example.new\n/);
  const remove = f.run(['set', '0:com.example.new', 'on']);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(readFileSync(f.file, 'utf8'), '10:com.example.one\n0:com.example.removed\n');
  assert.equal(readFileSync(path.join(f.state, 'refresh.trace'), 'utf8'), 'refresh\nrefresh\n');
});

test('failed refresh restores saved configuration and reapplies the previous scope', t => {
  const f = fixture(t); writeFileSync(f.file, '0:com.example.one\n');
  const r = f.run(['set', '0:com.example.new', 'off'], { TEST_APPLY_FAIL: '1' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /已恢复原排除名单/);
  assert.equal(readFileSync(f.file, 'utf8'), '0:com.example.one\n');
  assert.equal(readFileSync(path.join(f.state, 'refresh.trace'), 'utf8'), 'refresh\nrefresh\n');
});

test('lookup failure prevents both a configuration change and firewall refresh', t => {
  const f = fixture(t); writeFileSync(f.file, '0:com.example.one\n');
  const r = f.run(['set', '0:com.example.new', 'off'], { TEST_SYSTEM_CMD_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Package Manager backend failed/);
  assert.equal(readFileSync(f.file, 'utf8'), '0:com.example.one\n');
  assert.equal(existsSync(path.join(f.state, 'refresh.trace')), false);
  assert.deepEqual(readdirSync(path.join(f.root.dir, 'tmp')), []);
});

test('confirmed removed profiles are inactive, while failed user queries remain errors', t => {
  const f = fixture(t); writeFileSync(f.file, '0:com.example.one\n10:com.example.one\n');
  const r = f.run(['uids'], { TEST_USERS: 'Users:\n  UserInfo{0:Owner:13} running' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '10123\n');
  assert.match(readFileSync(f.file, 'utf8'), /10:com.example.one/);
  for (const snapshot of ['', 'Error: permission denied', 'Users:\n UserInfo{10:Work:30}']) {
    assert.notEqual(f.run(['uids'], { TEST_USERS: snapshot }).status, 0);
  }
});

test('an exclusion for an uninstalled application is valid and can be removed', t => {
  const f = fixture(t);
  const saved = f.run(['set', '0:com.example.uninstalled', 'off']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(f.run(['uids']).stdout, '');
  assert.equal(f.run(['set', '0:com.example.uninstalled', 'on']).status, 0);
});

for (const key of ['com.example.one', '0:com.example;id', '00:com.example.one', '99999:com.example.one', '0:com.example.$(id)']) {
  test('rejects invalid application selection: ' + key, t => {
    const f = fixture(t); assert.notEqual(f.run(['set', key, 'off']).status, 0);
    assert.equal(existsSync(f.file), false);
  });
}

