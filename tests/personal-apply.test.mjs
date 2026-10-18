import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t, { family = 'Magisk', present = true, failure = '', empty = false, invalid = false } = {}) {
  const root = rootFixture(t); root.addBusybox(family);
  const module = path.join(root.dir, 'module'), agh = path.join(root.dir, 'agh'), state = path.join(root.dir, 'state');
  mkdirSync(path.join(module, 'scripts'), { recursive: true });
  mkdirSync(path.join(agh, 'bin/userfilters'), { recursive: true }); mkdirSync(state);
  writeFileSync(path.join(module, 'scripts/compat.sh'), readFileSync(root.compatFile));
  writeFileSync(path.join(agh, 'admin.auth'), 'fixture:fixture');
  const personal = path.join(agh, 'bin/userfilters/adblock-pro-user-rules.txt');
  writeFileSync(personal, '||old.example^\n');
  const desired = invalid ? 'bad;command.example\n' : empty ? '' : 'new.example\n';
  writeFileSync(path.join(state, 'blacklist.txt'), desired); writeFileSync(path.join(state, 'whitelist.txt'), '');
  const marker = path.join(state, 'user-filter-applied');
  // Presence is read from the API, independently of this possibly stale marker.
  if (!present) writeFileSync(marker, shellPath(personal));
  const calls = path.join(root.dir, 'calls'), count = path.join(root.dir, 'count');
  const curl = path.join(root.dir, 'curl');
  writeFileSync(curl, `#!/bin/sh
method=GET; body=; url=
while [ "$#" -gt 0 ]; do
 case "$1" in
 -X) method=$2; shift 2 ;; --data-binary) body=$2; shift 2 ;;
 --user|-H|--max-time|--connect-timeout) shift 2 ;; http*) url=$1; shift ;; *) shift ;;
 esac
done
route=\${url#http://127.0.0.1:3000/control}
printf '%s\\t%s\\t%s\\n' "$method" "$route" "$body" >> "$CALLS"
case "$route" in
 /filtering/status)
  [ "$FAILURE" != status ] || exit 7
  if [ "$PRESENT" = 1 ]; then printf '{"enabled":false,"filters":[{"url":"%s","enabled":true}]}' "$PERSONAL"; else printf '{"enabled":false,"filters":[]}'; fi ;;
 /filtering/set_url)
  case "$body" in *'"enabled":true'*)
   n=$(cat "$COUNT" 2>/dev/null); n=$((\${n:-0}+1)); echo "$n" > "$COUNT"
   [ "$FAILURE" != always ] || exit 22
   [ "$FAILURE" != once ] || [ "$n" != 1 ] || exit 22 ;;
  esac ;;
 /filtering/add_url) [ "$FAILURE" != add ] || exit 22 ;;
 /filtering/remove_url) [ "$FAILURE" != remove ] || exit 22 ;;
 *) exit 99 ;;
esac
`); chmodSync(curl, 0o755);
  let script = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
  script = script.replace('AGH=/data/adb/adblockpro', `AGH=${shellPath(agh)}`).replace('STATE=/data/adb/bindhosts_personal', `STATE=${shellPath(state)}`);
  const entry = path.join(module, 'bindhosts.sh'); writeFileSync(entry, script);
  const run = () => spawnSync('bash', [shellPath(entry), '--apply-personal'], { encoding: 'utf8', timeout: 10000,
    env: { ...root.env(family), ABP_UPDATE_LOCKED: '1', CURL: shellPath(curl), CALLS: shellPath(calls), COUNT: shellPath(count), PERSONAL: shellPath(personal), PRESENT: present ? '1' : '0', FAILURE: failure } });
  const requests = () => readFileSync(calls, 'utf8').trim().split('\n').map(line => { const [method, route, body] = line.split('\t'); return { method, route, body: body ? JSON.parse(body) : null }; });
  return { run, requests, personal, desired, state, marker };
}

for (const family of ['KernelSU', 'Magisk', 'APatch']) test(`${family}: personal-only apply reloads its local filter without network refresh or enabling global filtering`, t => {
  const f = fixture(t, { family }), result = f.run(); assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(readFileSync(f.personal, 'utf8'), /\|\|new.example\^/);
  const calls = f.requests(); assert.deepEqual(calls.map(x => x.route), ['/filtering/status', '/filtering/set_url', '/filtering/set_url']);
  assert.deepEqual(calls.slice(1).map(x => x.body.data.enabled), [false, true]);
  assert.ok(calls.slice(1).every(x => x.body.url === shellPath(f.personal)));
  assert.ok(existsSync(f.marker)); assert.doesNotMatch(result.stdout, /更新完成/);
});

test('missing personal filter is registered despite a stale marker', t => {
  const f = fixture(t, { present: false }); assert.equal(f.run().status, 0);
  assert.deepEqual(f.requests().map(x => x.route), ['/filtering/status', '/filtering/add_url', '/filtering/set_url']);
});

test('clearing the personal lists removes only that filter', t => {
  const f = fixture(t, { empty: true }); assert.equal(f.run().status, 0);
  const calls = f.requests(); assert.deepEqual(calls.map(x => x.route), ['/filtering/status', '/filtering/remove_url']);
  assert.equal(calls[1].body.url, shellPath(f.personal)); assert.equal(existsSync(f.marker), false);
});

for (const failure of ['status', 'once', 'always', 'remove', 'add', 'invalid']) test(`personal apply failure (${failure}) retains desired lists and never reports success`, t => {
  const f = fixture(t, { failure, empty: failure === 'remove', present: failure !== 'add', invalid: failure === 'invalid' });
  const result = f.run(); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /\[成功\]/);
  assert.equal(readFileSync(f.personal, 'utf8'), '||old.example^\n');
  assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), f.desired);
  assert.ok(f.requests().every(x => !['/filtering/refresh', '/filtering/set_rules', '/filtering/config'].includes(x.route)));
  if (failure === 'once') assert.deepEqual(f.requests().filter(x => x.route === '/filtering/set_url').map(x => x.body.data.enabled), [false, true, false, true]);
});
