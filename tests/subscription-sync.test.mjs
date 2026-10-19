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
  mkdirSync(path.join(agh, 'certs'), { recursive: true });
  writeFileSync(path.join(agh, 'certs', 'cacert.pem'), 'fixture CA bundle\n');
  writeFileSync(path.join(mod, 'scripts', 'compat.sh'), readFileSync(root.compatFile, 'utf8'));
  const sourceList = path.join(root.dir, 'source-list.tsv'), calls = path.join(root.dir, 'api-calls.tsv');
  const curlCalls = path.join(root.dir, 'curl-calls.txt'), curlOptions = path.join(root.dir, 'curl-options.txt');
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
    'while [ "$#" -gt 0 ]; do case "$1" in --connect-timeout|--max-time) printf "%s\\t%s\\n" "$1" "$2" >> "$CURL_OPTIONS"; shift 2;; -o) output=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac; done',
    'printf "%s\\n" "$url" >> "$CURL_CALLS"',
    'printf "%s\\n" "$FAIL_URL" | grep -Fxq "$url" && { echo "curl: (${FAIL_CURL_CODE:-28}) simulated download failure" >&2; exit "${FAIL_CURL_CODE:-28}"; }',
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
  const env = { ...root.env('Magisk'), CURL: shellPath(curl), CURL_CALLS: shellPath(curlCalls), CURL_OPTIONS: shellPath(curlOptions), SOURCE_LIST: shellPath(sourceList), API_CALLS: shellPath(calls), FAIL_URL: failDownloadUrl || (failDownload ? feed : ''), FAIL_CURL_CODE: '28', FAIL_REMOVE: failRemove ? '1' : '0', STATUS_URL: existingShared ? shellPath(sharedFilter) : statusUrl, EXISTING_URL: existingShared ? shellPath(sharedFilter) : '' };
  const run = () => spawnSync('bash', [shellPath(script)], { encoding: 'utf8', timeout: 15000, env });
  return { run, state, agh, calls, curlCalls, curlOptions, oldCache, sharedFilter, env, script };
}

test('a due daily update downloads the subscribed remote source and registers its validated local cache', t => {
  const f = fixture(t);
  const automatic = bindhosts.slice(bindhosts.indexOf('auto_update_rules() {'), bindhosts.indexOf('\ndiagnose() {'));
  const script = readFileSync(f.script, 'utf8').replace(/\nsync_sources$/, '\n' + [
    'is_our_process() { return 0; }', 'is_dns_listening() { return 0; }',
    'update_rules() { sync_sources; }', automatic, 'auto_update_rules',
  ].join('\n'));
  writeFileSync(f.script, script);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(f.curlCalls, 'utf8').trim(), feed);
  assert.match(readFileSync(f.calls, 'utf8'), /POST\t\/filtering\/add_url\t.*adblock-pro-source-/);
  writeFileSync(path.join(f.state, 'auto-update'), 'off\n');
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(f.curlCalls, 'utf8').trim(), feed, 'off never sends a second download');
});

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
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), oldRecord);
  assert.equal(existsSync(f.calls) ? readFileSync(f.calls, 'utf8') : '', '');
  assert.equal(readFileSync(f.oldCache, 'utf8'), '||preserved.example^\n');
});

test('TLS certificate failures stay strict and show a useful diagnostic', t => {
  const sources = 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + feed + '\tenabled\tconfigured\tremovable\n';
  const f = fixture(t, { sources, failDownloadUrl: feed });
  f.env.FAIL_CURL_CODE = '60';
  const result = f.run();
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr, /curl: \(60\)/);
  assert.match(result.stderr, /未关闭证书校验/);
});

test('failed source download after failed shared sync skips rollback and keeps DNS running', t => {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const mod = path.join(root.dir, 'module'), state = path.join(root.dir, 'state');
  mkdirSync(path.join(mod, 'scripts'), { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(path.join(mod, 'scripts', 'compat.sh'), readFileSync(root.compatFile, 'utf8'));
  const config = path.join(mod, 'webui-config.sh');
  writeFileSync(config, '#!/bin/sh\nprintf "mode\\tbalanced\\nsource\\tshared\\tShared Rules\\tshared\\tenabled\\tbundled\\tremovable\\n"\n');
  const ruleStore = path.join(mod, 'rule-store.sh');
  writeFileSync(ruleStore, '#!/bin/sh\necho "simulated shared download failure" >&2\nexit 1\n');
  const script = path.join(root.dir, 'update-flow.sh');
  const update = bindhosts.slice(bindhosts.indexOf('update_rules() {'), bindhosts.indexOf('\ndiagnose() {'));
  writeFileSync(script, [
    '#!/bin/sh',
    'BB=' + shellPath(root.paths.Magisk),
    'MODDIR=' + shellPath(mod),
    'STATE=' + shellPath(state),
    'RULE_STORE=' + shellPath(ruleStore),
    'API=http://unused',
    'api() { [ "$1 $2" = "GET /status" ]; }',
    'save_snapshot() { LAST_SNAPSHOT=fixture; return 0; }',
    'sync_sources() { echo "curl: (35) Recv failure: Connection reset by peer" >&2; return 2; }',
    'sync_personal_filter() { echo "must not run" >&2; return 1; }',
    'update_failed() { echo "rollback must not run" >&2; return 1; }',
    update,
    'update_rules',
  ].join('\n'));
  const result = spawnSync('bash', [shellPath(script)], { encoding: 'utf8', timeout: 10000, env: root.env('Magisk') });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /Connection reset by peer/);
  assert.match(result.stderr, /订阅配置未更改，DNS 核心保持运行/);
  assert.doesNotMatch(result.stderr, /rollback must not run/);
  assert.doesNotMatch(result.stderr, /must not run/);
});

test('failed source download after successful shared sync also keeps DNS running', t => {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const mod = path.join(root.dir, 'module'), state = path.join(root.dir, 'state');
  mkdirSync(path.join(mod, 'scripts'), { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(path.join(mod, 'scripts', 'compat.sh'), readFileSync(root.compatFile, 'utf8'));
  const config = path.join(mod, 'webui-config.sh');
  writeFileSync(config, '#!/bin/sh\nprintf "mode\\tbalanced\\nsource\\tshared\\tShared Rules\\tshared\\tenabled\\tbundled\\tremovable\\n"\n');
  const ruleStore = path.join(mod, 'rule-store.sh');
  writeFileSync(ruleStore, '#!/bin/sh\necho "[+] simulated shared sync success"\nexit 0\n');
  const script = path.join(root.dir, 'update-flow.sh');
  const update = bindhosts.slice(bindhosts.indexOf('update_rules() {'), bindhosts.indexOf('\ndiagnose() {'));
  writeFileSync(script, [
    '#!/bin/sh',
    'BB=' + shellPath(root.paths.Magisk),
    'MODDIR=' + shellPath(mod),
    'STATE=' + shellPath(state),
    'RULE_STORE=' + shellPath(ruleStore),
    'API=http://unused',
    'api() { [ "$1 $2" = "GET /status" ]; }',
    'save_snapshot() { LAST_SNAPSHOT=fixture; return 0; }',
    'sync_sources() { echo "curl: (28) Resolving timed out" >&2; return 2; }',
    'sync_personal_filter() { echo "must not run" >&2; return 1; }',
    'update_failed() { echo "rollback must not run" >&2; return 1; }',
    update,
    'update_rules',
  ].join('\n'));
  const result = spawnSync('bash', [shellPath(script)], { encoding: 'utf8', timeout: 10000, env: root.env('Magisk') });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /Resolving timed out/);
  assert.match(result.stderr, /订阅配置未更改，DNS 核心保持运行/);
  assert.doesNotMatch(result.stderr, /rollback must not run/);
  assert.doesNotMatch(result.stderr, /must not run/);
});

test('built-in sources retry their verified HTTPS mirrors when original URLs fail', t => {
  const cases = [
    ['https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward', 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward'],
    ['https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt', 'https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt'],
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

test('10007 source falls through to the GCore CDN when jsDelivr and GitHub Raw fail', t => {
  const original = 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward';
  const raw = 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
  const gcore = 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward';
  const sources = 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + original + '\tenabled\tconfigured\tremovable\n';
  const f = fixture(t, { sources, failDownloadUrl: original + '\n' + raw });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(readFileSync(f.curlCalls, 'utf8').trim().split('\n'), [original, raw, gcore]);
});

test('official 10007 reward EdgeOne link retries GitHub Pages and CDN mirrors', t => {
  const original = 'https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
  const githubPages = 'https://lingeringsound.github.io/10007_auto/reward';
  const cdn = 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward';
  const raw = 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
  const gcore = 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward';
  const sources = 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + original + '\tenabled\tconfigured\tremovable\n';
  const f = fixture(t, { sources, failDownloadUrl: original + '\n' + githubPages + '\n' + cdn + '\n' + raw });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(readFileSync(f.curlCalls, 'utf8').trim().split('\n'), [original, githubPages, cdn, raw, gcore]);
  assert.match(result.stdout,/尝试规则源：edgeone\.gh-proxy\.org/);
  assert.match(result.stdout,/正在尝试 HTTPS 镜像：lingeringsound\.github\.io/);
  assert.deepEqual(readFileSync(f.curlOptions, 'utf8').trim().split('\n'), Array.from({length: 10}, (_, index) => `--${index % 2 === 0 ? 'connect-timeout\t10' : 'max-time\t20'}`));
});

test('official AWAvenue AdGuard full-rule mirror uses Wang Fugui then retries CXPLAY and CDN', t => {
  const original = 'https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt';
  const cxplay = 'https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt';
  const gcore = 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt';
  const sources = 'mode\tbalanced\nsource\tcustom\tExample Feed\t' + original + '\tenabled\tconfigured\tremovable\n';
  const f = fixture(t, { sources, failDownloadUrl: original + '\n' + cxplay });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(readFileSync(f.curlCalls, 'utf8').trim().split('\n'), [original, cxplay, gcore]);
  assert.match(result.stdout,/尝试规则源：cdn\.uura\.cn/);
  assert.match(result.stdout,/正在尝试 HTTPS 镜像：script\.cx\.ms/);
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
