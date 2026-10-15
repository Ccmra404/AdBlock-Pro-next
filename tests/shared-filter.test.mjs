import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t, { present = true, failSet = false, selected = true } = {}) {
  const root = rootFixture(t);
  root.addBusybox('Magisk');
  const module = path.join(root.dir, 'module');
  const agh = path.join(root.dir, 'agh');
  const state = path.join(root.dir, 'state');
  const scripts = path.join(module, 'scripts');
  const apiScripts = path.join(agh, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(apiScripts, { recursive: true });
  mkdirSync(path.join(agh, 'bin', 'userfilters'), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(scripts, 'compat.sh'), readFileSync(root.compatFile, 'utf8'));
  writeFileSync(path.join(apiScripts, 'rule-store.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(module, 'webui-config.sh'), `#!/bin/sh
[ "$1" = list-sources ] || exit 1
printf 'mode\\tbalanced\\n'
if [ "$SHARED_SELECTED" = 1 ]; then printf 'source\\tshared\\tShared\\tshared\\tenabled\\tconfigured\\tremovable\\n'; fi
`);
  writeFileSync(path.join(agh, 'admin.auth'), 'test:test\n');

  const status = path.join(root.dir, 'filtering-status.json');
  const calls = path.join(root.dir, 'api-calls.txt');
  const sharedFilter = shellPath(path.join(agh, 'bin', 'userfilters', 'adblock-pro-shared-app-rules.txt'));
  writeFileSync(status, JSON.stringify({ filters: present ? [{ url: sharedFilter, enabled: false }] : [] }));
  const curl = path.join(root.dir, 'curl');
  writeFileSync(curl, `#!/bin/sh
method=GET
url=
body=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift 2 ;;
    --data-binary) body=$2; shift 2 ;;
    --user|-H|--max-time|--connect-timeout) shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
path=$(printf '%s' "$url" | sed 's#^http://127.0.0.1:3000/control##')
printf '%s\t%s\t%s\n' "$method" "$path" "$body" >> "$API_CALLS"
case "$method $path" in
  'GET /filtering/status') cat "$FILTER_STATUS" ;;
  'POST /filtering/add_url') exit 0 ;;
  'POST /filtering/set_url') [ "$FAIL_SET" != 1 ] || exit 22 ;;
  'POST /filtering/remove_url') printf '{"filters":[]}' > "$FILTER_STATUS" ;;
  *) exit 22 ;;
esac
`);
  chmodSync(curl, 0o755);

  let script = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
  script = script.replace('AGH=/data/adb/adblockpro', `AGH=${shellPath(agh)}`)
    .replace('STATE=/data/adb/bindhosts_personal', `STATE=${shellPath(state)}`);
  const entry = path.join(module, 'bindhosts.sh');
  writeFileSync(entry, script);
  const env = {
    ...root.env('Magisk'), CURL: shellPath(curl),
    FILTER_STATUS: shellPath(status), API_CALLS: shellPath(calls),
    FAIL_SET: failSet ? '1' : '0',
    SHARED_SELECTED: selected ? '1' : '0',
  };
  const run = () => spawnSync('bash', [shellPath(entry), '--ensure-shared'], { encoding: 'utf8', timeout: 10000, env });
  return { run, calls, status, sharedFilter };
}

test('a disabled bundled shared filter is explicitly enabled before it is reported ready', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => line.split('\t'));
  assert.deepEqual(calls.map(([method, url]) => [method, url]), [
    ['GET', '/filtering/status'],
    ['POST', '/filtering/set_url'],
  ]);
  const update = JSON.parse(calls[1][2]);
  assert.equal(update.url, f.sharedFilter);
  assert.equal(update.data.enabled, true);
});

test('a missing bundled shared filter is added and then enabled', t => {
  const f = fixture(t, { present: false });
  const result = f.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => line.split('\t'));
  assert.deepEqual(calls.map(([method, url]) => [method, url]), [
    ['GET', '/filtering/status'],
    ['POST', '/filtering/add_url'],
    ['POST', '/filtering/set_url'],
  ]);
  assert.equal(JSON.parse(calls[2][2]).data.enabled, true);
});

test('failure to enable the bundled shared filter is not reported as success', t => {
  const f = fixture(t, { failSet: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(readFileSync(f.calls, 'utf8'), /POST\t\/filtering\/set_url\t/);
});

test('an unselected shared source is removed from the live filter instead of being re-enabled', t => {
  const f = fixture(t, { selected: false });
  const result = f.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => line.split('\t'));
  assert.deepEqual(calls.map(([method, url]) => [method, url]), [['POST', '/filtering/remove_url']]);
});
