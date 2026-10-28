import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const bundle = readFileSync(new URL('../rules/shared-app-domains.txt', import.meta.url), 'utf8');
const bundledDomains = bundle.split(/\r?\n/).filter(row => row && !row.startsWith('#')).sort();
const nextRevision = Number(bundle.match(/^# revision: (\d+)$/m)[1]) + 1;

for (const [name, black, white, input] of [
  ['conflicting tags in one file', '', '', 'B\tads.example\nW\tads.example\n'],
  ['a stale block import conflicts with a saved allow entry', '', 'ADS.Example\r\n', 'B\tads.example\n'],
  ['a stale allow import conflicts with a saved block entry', 'ads.example\n', '', 'W\tads.example\n'],
]) test(`personal import rejects ${name} without partial writes`, t => {
  const f = fixture(t);
  writeFileSync(path.join(f.state, 'blacklist.txt'), black);
  writeFileSync(path.join(f.state, 'whitelist.txt'), white);
  const before = f.privateSnapshot();
  const result = f.run('import', Buffer.from(input).toString('base64'));
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(f.privateSnapshot(), before);
});

function fixture(t, { registry = '' } = {}) {
  const f = rootFixture(t); f.addBusybox('Magisk');
  const state = path.join(f.dir, 'state'), agh = path.join(f.dir, 'agh'), module = path.join(f.dir, 'module');
  mkdirSync(state); mkdirSync(path.join(module, 'rules'), { recursive:true });
  mkdirSync(path.join(agh, 'certs'), { recursive:true });
  writeFileSync(path.join(agh, 'certs', 'cacert.pem'), 'fixture CA bundle\n');
  const bundle = readFileSync(new URL('../rules/shared-app-domains.txt', import.meta.url));
  writeFileSync(path.join(module, 'rules/shared-app-domains.txt'), bundle);
  const script = path.join(f.dir, 'scripts/rule-store.sh');
  writeFileSync(script, 'if [ -n "$ABP_COMMAND_DIR" ]; then export PATH="$ABP_COMMAND_DIR:$PATH"; fi\n' + readFileSync(new URL('../scripts/rule-store.sh', import.meta.url)));
  if (registry) {
    writeFileSync(path.join(f.dir, 'scripts/source-registry.sh'), readFileSync(new URL('../scripts/source-registry.sh', import.meta.url)));
    writeFileSync(path.join(module, 'rules/source-registry.tsv'), readFileSync(new URL('../rules/source-registry.tsv', import.meta.url)));
    writeFileSync(path.join(state, 'source-registry.tsv'), registry);
  }
  for (const [kind,text] of [['blacklist','# local comment\nads.local.example\n'], ['whitelist','login.local.example\n']])
    writeFileSync(path.join(state,kind+'.txt'),text);
  const remote = path.join(f.dir,'remote');
  writeFileSync(remote,bundle);
  const curl = path.join(f.dir,'curl');
  writeFileSync(curl,'#!/bin/sh\noutput= url=\nwhile [ "$#" -gt 0 ]; do case "$1" in --cacert|--connect-timeout|--max-time|--max-filesize) shift 2;; -o) output=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac; done\nprintf "%s\\n" "$url" >> "$CURL_URLS"\n[ "$url" != "$FAIL_URL" ] || { echo "curl: (28) simulated timeout" >&2; exit 28; }\n[ "$FAIL_DOWNLOAD" != 1 ] || { echo "curl: (${FAIL_CURL_CODE:-28}) simulated failure" >&2; exit "${FAIL_CURL_CODE:-28}"; }\n[ "$FAIL_TLS" != 1 ] || { echo "curl: (60) certificate verify failed" >&2; exit 60; }\ncp "$REMOTE" "$output"\n'); chmodSync(curl,0o755);
  const env = { ...f.env('Magisk'), ABP_STATE_DIR:shellPath(state), ABP_AGH_DIR:shellPath(agh), ABP_MODULE_DIR:shellPath(module), CURL:shellPath(curl), REMOTE:shellPath(remote), CURL_URLS:shellPath(path.join(f.dir,'curl-urls')), ABP_EXPORT_DIR:shellPath(path.join(f.dir,'exports')) };
  const run = (...args) => spawnSync('bash',[shellPath(script),...args],{env,encoding:'utf8',timeout:10000});
  const file = path.join(state,'shared-app-domains.txt'), filter = path.join(agh,'bin/userfilters/adblock-pro-shared-app-rules.txt');
  const privateSnapshot = () => ['blacklist','whitelist'].map(k=>readFileSync(path.join(state,k+'.txt'),'utf8'));
  return { run, state, remote, file, filter, env, privateSnapshot, dir:f.dir, curlUrls:path.join(f.dir,'curl-urls') };
}

test('offline shared bank is installed independently and idempotently on existing devices', t=>{
  const f=fixture(t), before=f.privateSnapshot();
  assert.equal(f.run('init').status,0);
  const snapshot=readFileSync(f.file,'utf8');
  assert.deepEqual(readFileSync(f.filter,'utf8').trim().split('\n'), bundledDomains.map(domain => '||' + domain + '^'));
  assert.equal(f.run('init').status,0);
  assert.equal(readFileSync(f.file,'utf8'),snapshot);
  assert.deepEqual(f.privateSnapshot(),before);
  assert.deepEqual(f.run('show').stdout.split('\n').filter(x=>x.startsWith('domain\t')).map(row => row.slice(7)), bundledDomains);
});

test('shared sync validates downloaded data and retains newer cached versions across reinstall', t=>{
  const f=fixture(t); assert.equal(f.run('init').status,0);
  const before=readFileSync(f.file,'utf8'), original=readFileSync(f.filter,'utf8');
  for(const content of ['<html>proxy failure</html>', '# revision: 2026101301\nold.example\n', `# revision: ${nextRevision}\nhttps://bad.example\n`, `# revision: ${nextRevision}\n# revision: ${nextRevision+1}\na.example\n`, `# revision: ${nextRevision}\n`+'a'.repeat(64)+'.example\n']) {
    writeFileSync(f.remote,content);
    assert.notEqual(f.run('sync').status,0);
    assert.equal(readFileSync(f.file,'utf8'),before); assert.equal(readFileSync(f.filter,'utf8'),original);
  }
  f.env.FAIL_DOWNLOAD='1'; assert.notEqual(f.run('sync').status,0); delete f.env.FAIL_DOWNLOAD;
  writeFileSync(f.remote,`# revision: ${nextRevision}\nNew.Example\nnew.example\n`);
  assert.equal(f.run('sync').status,0); assert.equal(readFileSync(f.filter,'utf8'),'||new.example^\n');
  assert.equal(f.run('init').status,0); assert.equal(readFileSync(f.filter,'utf8'),'||new.example^\n');
});

test('shared sync retries the official CDN mirror when GitHub Raw is unavailable', t=>{
  const f=fixture(t); assert.equal(f.run('init').status,0);
  f.env.FAIL_URL='https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt';
  const result=f.run('sync');
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.deepEqual(readFileSync(f.curlUrls,'utf8').trim().split('\n'),[
    'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt',
    'https://gcore.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/shared-app-domains.txt',
  ]);
  assert.match(result.stdout,/共享规则已从 HTTPS 镜像获取/);
});

test('shared sync uses the updated registry without changing personal lists', t=>{
  const original = 'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt';
  const mirror = 'https://rules.example.org/shared.txt';
  const registry = readFileSync(new URL('../rules/source-registry.tsv', import.meta.url), 'utf8')
    .replace('revision: 2026102801', 'revision: 2026102802').replace(original, mirror);
  const f = fixture(t, { registry }); const before=f.privateSnapshot();
  assert.equal(f.run('init').status,0);
  const result=f.run('sync'); assert.equal(result.status,0,result.stderr+result.stdout);
  assert.deepEqual(readFileSync(f.curlUrls,'utf8').trim().split('\n'), [mirror]);
  assert.deepEqual(f.privateSnapshot(), before);
});

test('a test build with a commit-scoped shared source does not use the production registry', t=>{
  const original = 'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt';
  const registry = readFileSync(new URL('../rules/source-registry.tsv', import.meta.url), 'utf8')
    .replace('revision: 2026102801', 'revision: 2026102802').replace(original, 'https://rules.example.org/shared.txt');
  const f = fixture(t, { registry }); const commitUrl=original.replace('/main/', '/' + 'a'.repeat(40) + '/');
  f.env.ABP_SHARED_RULES_URL=commitUrl;
  assert.equal(f.run('init').status,0);
  const result=f.run('sync'); assert.equal(result.status,0,result.stderr+result.stdout);
  assert.deepEqual(readFileSync(f.curlUrls,'utf8').trim().split('\n'), [commitUrl]);
});

test('shared sync distinguishes DNS, timeout, TLS connection and certificate failures while retaining snapshots', t=>{
  const f=fixture(t); assert.equal(f.run('init').status,0);
  const before=readFileSync(f.file,'utf8'), original=readFileSync(f.filter,'utf8'), lists=f.privateSnapshot();
  f.env.FAIL_DOWNLOAD='1';
  f.env.FAIL_CURL_CODE='6';
  const dns=f.run('sync');
  assert.notEqual(dns.status,0);
  assert.match(dns.stderr,/域名解析失败/);
  assert.match(dns.stderr,/现有共享规则快照和个人名单均已保留/);
  assert.deepEqual(readFileSync(f.curlUrls,'utf8').trim().split('\n'),[
    'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt',
    'https://gcore.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/shared-app-domains.txt',
    'https://cdn.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/shared-app-domains.txt',
  ]);
  assert.equal(readFileSync(f.file,'utf8'),before); assert.equal(readFileSync(f.filter,'utf8'),original); assert.deepEqual(f.privateSnapshot(),lists);
  f.env.FAIL_CURL_CODE='28';
  const timeout=f.run('sync');
  assert.notEqual(timeout.status,0); assert.match(timeout.stderr,/请求超时.*解析、连接或下载/); assert.doesNotMatch(timeout.stderr,/域名解析失败/);
  f.env.FAIL_CURL_CODE='35';
  const handshake=f.run('sync');
  assert.notEqual(handshake.status,0); assert.match(handshake.stderr,/TLS 连接失败/); assert.doesNotMatch(handshake.stderr,/证书校验失败/);
  assert.equal(readFileSync(f.file,'utf8'),before); assert.equal(readFileSync(f.filter,'utf8'),original); assert.deepEqual(f.privateSnapshot(),lists);
  f.env.FAIL_TLS='1'; delete f.env.FAIL_DOWNLOAD;
  const tls=f.run('sync');
  assert.notEqual(tls.status,0); assert.match(tls.stderr,/TLS 证书校验失败/);
  assert.equal(readFileSync(f.file,'utf8'),before); assert.equal(readFileSync(f.filter,'utf8'),original); assert.deepEqual(f.privateSnapshot(),lists);
});

test('personal import merges, deduplicates, preserves comments and rejects entire malformed input', t=>{
  const f=fixture(t), encode=s=>Buffer.from(s).toString('base64');
  assert.equal(f.run('import',encode('B\tADS.LOCAL.EXAMPLE\nB\tnew.example\nW\tallow.example\n')).status,0);
  assert.deepEqual(f.privateSnapshot(),['# local comment\nads.local.example\nnew.example\n','login.local.example\nallow.example\n']);
  const before=f.privateSnapshot();
  for(const data of ['B\tvalid.example\nB\tbad;rm.example\n','W\tbad..example\n','X\tvalid.example\n','B\t'+ 'x'.repeat(64)+'.example\n','']) {
    assert.notEqual(f.run('import',encode(data)).status,0); assert.deepEqual(f.privateSnapshot(),before);
  }
  assert.equal(f.run('import',encode('B\tnew.example\n')).status,0); assert.deepEqual(f.privateSnapshot(),before);
});

test('failed second personal-file rename restores both previous lists', t=>{
  const f=fixture(t), before=f.privateSnapshot();
  const mock=path.join(f.dir,'mock'); mkdirSync(mock);
  writeFileSync(path.join(mock,'mv'),'#!/bin/sh\ncase "$1" in */whitelist.next) exit 1;; esac\nexec /usr/bin/mv "$@"\n'); chmodSync(path.join(mock,'mv'),0o755);
  f.env.ABP_COMMAND_DIR=shellPath(mock);
  assert.notEqual(f.run('import',Buffer.from('B\tnew.example\nW\tallow.example\n').toString('base64')).status,0);
  assert.deepEqual(f.privateSnapshot(),before);
});

test('exports preserve separate scopes and refuse overwriting a prior download', t=>{
  const f=fixture(t); assert.equal(f.run('init').status,0);
  assert.equal(f.run('export','local','123').status,0);
  const target=path.join(f.dir,'exports/AdBlock-Pro-personal-rules-123.txt');
  assert.match(readFileSync(target,'utf8'),/\[拦截名单\][\s\S]*ads.local.example[\s\S]*\[放行名单\][\s\S]*login.local.example/);
  assert.notEqual(f.run('export','local','123').status,0);
  assert.equal(f.run('export','shared','124').status,0);
  assert.match(readFileSync(path.join(f.dir,'exports/AdBlock-Pro-shared-rules-124.txt'),'utf8'),/# revision:/);
  assert.equal(existsSync(path.join(f.state,'shared-app-domains.txt')),true);
});

test('logs and observed-domain exports share the module folder and refuse overwrites', t=>{
  const f=fixture(t);
  const logs=Buffer.from('[{"status":"success"}]').toString('base64');
  const domains=Buffer.from('ads.example\n').toString('base64');
  assert.equal(f.run('write','operation-logs','125',logs).status,0);
  assert.equal(readFileSync(path.join(f.dir,'exports/AdBlock-Pro-operation-logs-125.json'),'utf8'),'[{"status":"success"}]');
  assert.equal(f.run('write','observed-domains','126',domains).status,0);
  assert.equal(readFileSync(path.join(f.dir,'exports/AdBlock-Pro-observed-domains-126.txt'),'utf8'),'ads.example\n');
  assert.notEqual(f.run('write','observed-domains','126',domains).status,0);
  assert.notEqual(f.run('write','arbitrary-file','127',domains).status,0);
});
