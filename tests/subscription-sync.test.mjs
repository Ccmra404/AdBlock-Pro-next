import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const bindhosts = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
const helpers = bindhosts.slice(bindhosts.indexOf('source_name() {'), bindhosts.indexOf('\nwrite_personal_filter() {'));
const feed = 'https://filters.example/list.txt';
const nativePath = value => process.platform === 'win32' ? value.replace(/^\/([a-z])\//, (_, drive) => drive.toUpperCase() + ':/') : value;

function fixture(t, { sources, oldApplied = '', marker = true, failDownload = false, failDownloadUrl = '', failRemove = false, statusUrl = '', existingShared = false } = {}) {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const mod = path.join(root.dir, 'module'), agh = path.join(root.dir, 'agh'), state = path.join(root.dir, 'state');
  mkdirSync(path.join(mod, 'scripts'), { recursive: true });
  mkdirSync(path.join(agh, 'bin', 'userfilters'), { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(path.join(mod, 'scripts', 'compat.sh'), readFileSync(root.compatFile, 'utf8'));
  const sourceList = path.join(root.dir, 'source-list.tsv'), calls = path.join(root.dir, 'api-calls.tsv');
  const curlCalls = path.join(root.dir, 'curl-calls.txt');
  const sharedFilter = path.join(agh, 'bin', 'userfilters', 'adblock-pro-shared-app-rules.txt');
  writeFileSync(sharedFilter, '||shared.example^\n');
  writeFileSync(sourceList, sources ?? 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + feed + '\tenabled\tconfigured\tremovable\n');
  writeFileSync(path.join(mod, 'webui-config.sh'), '#!/bin/sh\n[ "$1" = list-sources ] || exit 1\ncat "$SOURCE_LIST"\n');
  if (oldApplied !== null) writeFileSync(path.join(state, 'sources-applied.txt'), oldApplied);
  if (marker) writeFileSync(path.join(state, 'sources-local-v2'), 'local-v2\n');
  const oldCache = path.join(agh, 'bin', 'userfilters', 'adblock-pro-source-old.txt');
  writeFileSync(oldCache, '||preserved.example^\n');

  const curl = path.join(root.dir, 'curl');
  writeFileSync(curl, [
    '#!/bin/sh',
    'output= url=',
    'while [ "$#" -gt 0 ]; do case "$1" in -o) output=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac; done',
    'printf "%s\\n" "$url" >> "$CURL_CALLS"',
    '[ "$url" != "$FAIL_URL" ] || { echo "simulated download failure" >&2; exit 28; }',
    'printf "||ads.example^\\n" > "$output"',
  ].join('\n'));
  chmodSync(curl, 0o755);

  const api = [
    'api() {',
    '  method=$1; endpoint=$2; body=$3',
    '  printf "%s\\t%s\\t%s\\n" "$method" "$endpoint" "$body" >> "$API_CALLS"',
    '  case "$method $endpoint" in',
    '    "GET /filtering/status") printf "{\\"filters\\":[{\\"url\\":\\"%s\\"}]}\\n" "$STATUS_URL" ;;',
    '    "POST /filtering/remove_url") [ "$FAIL_REMOVE" != 1 ] ;;',
    '    "POST /filtering/add_url")',
    '      if [ -n "$EXISTING_URL" ]; then case "$body" in *"$EXISTING_URL"*) return 22 ;; esac; fi',
    '      return 0 ;;',
    '    "POST /filtering/set_url") return 0 ;;',
    '    *) return 22 ;;',
    '  esac',
    '}',
  ].join('\n');
  const script = path.join(root.dir, 'sync-sources.sh');
  const body = [
    '#!/bin/sh',
    'MODDIR=' + shellPath(mod),
    'AGH=' + shellPath(agh),
    'STATE=' + shellPath(state),
    'SHARED_FILTER=' + shellPath(path.join(agh, 'bin', 'userfilters', 'adblock-pro-shared-app-rules.txt')),
    '. ' + shellPath(path.join(mod, 'scripts', 'compat.sh')) + ' || exit 1',
    api,
    helpers,
    'sync_sources',
  ].join('\n');
  writeFileSync(script, body); chmodSync(script, 0o755);
  const env = { ...root.env('Magisk'), CURL: shellPath(curl), CURL_CALLS: shellPath(curlCalls), SOURCE_LIST: shellPath(sourceList), API_CALLS: shellPath(calls), FAIL_URL: failDownloadUrl || (failDownload ? feed : ''), FAIL_REMOVE: failRemove ? '1' : '0', STATUS_URL: existingShared ? shellPath(sharedFilter) : statusUrl, EXISTING_URL: existingShared ? shellPath(sharedFilter) : '' };
  const run = () => spawnSync('bash', [shellPath(script)], { encoding: 'utf8', timeout: 15000, env });
  return { run, state, agh, calls, curlCalls, oldCache, sharedFilter };
}

test('subscriptions download through system curl and AdGuard Home receives only the validated local file', t => {
  const f = fixture(t, { marker: false, oldApplied: feed + '\n' });
  const result = f.run();
  assert.equal(result.status, 0, JSON.stringify(result));
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /POST\t\/filtering\/remove_url\t.*filters\.example\/list\.txt/);
  const add = calls.split('\n').find(line => line.startsWith('POST\t/filtering/add_url\t'));
  assert.ok(add); assert.doesNotMatch(add, /https:\/\/filters\.example/);
  const localPath = JSON.parse(add.split('\t').slice(2).join('\t')).url;
  assert.ok(localPath.includes('adblock-pro-source-'));
  assert.match(readFileSync(nativePath(localPath), 'utf8'), /ads\.example/);
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), feed + '\n');
});

test('a failed subscription download keeps the previous applied source record and never mutates AdGuard Home', t => {
  const oldRecord = 'https://old.example/list.txt\n';
  const f = fixture(t, { oldApplied: oldRecord, failDownload: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), oldRecord);
  assert.equal(existsSync(f.calls) ? readFileSync(f.calls, 'utf8') : '', '');
  assert.equal(readFileSync(f.oldCache, 'utf8'), '||preserved.example^\n');
});

test('built-in sources retry their verified HTTPS mirrors when original URLs fail', t => {
  const cases = [
    ['https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward', 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward'],
    ['https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt', 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt'],
    ['https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward', 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward'],
    ['https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', 'https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/gh-pages/Filters/filter.txt'],
  ];
  for (const [original, mirror] of cases) {
    const sources = 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + original + '\tenabled\tconfigured\tremovable\n';
    const f = fixture(t, { sources, failDownloadUrl: original });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(readFileSync(f.curlCalls, 'utf8').trim().split('\n'), [original, mirror]);
    assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), original + '\n');
  }
});

test('legacy migration updates an already registered shared filter instead of adding it twice', t => {
  const sources = 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + feed + '\tenabled\tconfigured\tremovable\nsource\tshared\tShared Rules\tshared\tenabled\tbundled\tremovable\n';
  const f = fixture(t, { sources, marker: false, oldApplied: '', existingShared: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => line.split('\t'));
  const sharedAdds = calls.filter(([method, endpoint, body]) => method === 'POST' && endpoint === '/filtering/add_url' && JSON.parse(body).url === shellPath(f.sharedFilter));
  assert.equal(sharedAdds.length, 0);
  const sharedUpdate = calls.find(([method, endpoint, body]) => method === 'POST' && endpoint === '/filtering/set_url' && JSON.parse(body).url === shellPath(f.sharedFilter));
  assert.ok(sharedUpdate, 'the existing shared filter must still be reconciled');
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), feed + '\nshared\n');
});

test('deselecting a previously applied URL removes its local filter and clears only module-owned state', t => {
  const f = fixture(t, { sources: 'mode\tbalanced\n', oldApplied: feed + '\n' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = readFileSync(f.calls, 'utf8');
  assert.match(calls, /POST\t\/filtering\/remove_url\t.*adblock-pro-source-/);
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), '');
});

test('removal verification matches exact filter URLs instead of a shared prefix', t => {
  const f = fixture(t, { marker: false, oldApplied: feed + '\n', failRemove: true, statusUrl: feed + '-other' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(readFileSync(f.calls, 'utf8'), /GET\t\/filtering\/status/);
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), feed + '\n');
});
