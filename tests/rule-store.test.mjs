import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const bundle = readFileSync(new URL('../rules/shared-app-domains.txt', import.meta.url), 'utf8');
const bundledDomains = bundle.split(/\r?\n/).filter(row => row && !row.startsWith('#')).sort();
const nextRevision = Number(bundle.match(/^# revision: (\d+)$/m)[1]) + 1;

function fixture(t) {
  const f = rootFixture(t); f.addBusybox('Magisk');
  const state = path.join(f.dir, 'state'), agh = path.join(f.dir, 'agh'), module = path.join(f.dir, 'module');
  mkdirSync(state); mkdirSync(path.join(module, 'rules'), { recursive:true });
  const bundle = readFileSync(new URL('../rules/shared-app-domains.txt', import.meta.url));
  writeFileSync(path.join(module, 'rules/shared-app-domains.txt'), bundle);
  const script = path.join(f.dir, 'scripts/rule-store.sh');
  writeFileSync(script, 'if [ -n "$ABP_COMMAND_DIR" ]; then export PATH="$ABP_COMMAND_DIR:$PATH"; fi\n' + readFileSync(new URL('../scripts/rule-store.sh', import.meta.url)));
  for (const [kind,text] of [['blacklist','# local comment\nads.local.example\n'], ['whitelist','login.local.example\n']])
    writeFileSync(path.join(state,kind+'.txt'),text);
  const remote = path.join(f.dir,'remote');
  writeFileSync(remote,bundle);
  const curl = path.join(f.dir,'curl');
  writeFileSync(curl,'#!/bin/sh\n[ "$FAIL_DOWNLOAD" != 1 ] || exit 28\nwhile [ "$1" != -o ]; do shift; done\ncp "$REMOTE" "$2"\n'); chmodSync(curl,0o755);
  const env = { ...f.env('Magisk'), ABP_STATE_DIR:shellPath(state), ABP_AGH_DIR:shellPath(agh), ABP_MODULE_DIR:shellPath(module), CURL:shellPath(curl), REMOTE:shellPath(remote), ABP_EXPORT_DIR:shellPath(path.join(f.dir,'exports')) };
  const run = (...args) => spawnSync('bash',[shellPath(script),...args],{env,encoding:'utf8',timeout:10000});
  const file = path.join(state,'shared-app-domains.txt'), filter = path.join(agh,'bin/userfilters/adblock-pro-shared-app-rules.txt');
  const privateSnapshot = () => ['blacklist','whitelist'].map(k=>readFileSync(path.join(state,k+'.txt'),'utf8'));
  return { run, state, remote, file, filter, env, privateSnapshot, dir:f.dir };
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
  const target=path.join(f.dir,'exports/adblock-pro-local-rules-123.txt');
  assert.match(readFileSync(target,'utf8'),/\[拦截名单\][\s\S]*ads.local.example[\s\S]*\[放行名单\][\s\S]*login.local.example/);
  assert.notEqual(f.run('export','local','123').status,0);
  assert.equal(f.run('export','shared','124').status,0);
  assert.match(readFileSync(path.join(f.dir,'exports/adblock-pro-shared-rules-124.txt'),'utf8'),/# revision:/);
  assert.equal(existsSync(path.join(f.state,'shared-app-domains.txt')),true);
});
