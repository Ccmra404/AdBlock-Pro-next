import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const job = readFileSync(new URL('../webui-job.sh',import.meta.url),'utf8');
const bind = readFileSync(new URL('../bindhosts.sh',import.meta.url),'utf8');
function fixture(t,family='Magisk',code=0) {
  const f=rootFixture(t); f.addBusybox(family);
  const agh=path.join(f.dir,'agh'), jobs=path.join(f.dir,'jobs'); mkdirSync(path.join(agh,'bin'),{recursive:true}); mkdirSync(path.join(agh,'scripts'),{recursive:true});
  const helper=path.join(agh,'bin/adblock-bootstrap');
  writeFileSync(helper,`#!/bin/sh\n[ "$1" = dns ] || exit 99\nif [ "$2" != info ]; then cat > '${shellPath(path.join(f.dir,'decoded'))}'; fi\nprintf '%s\\n' "$2"\nexit ${code}\n`); chmodSync(helper,0o755);
  const worker=path.join(f.dir,'job.sh');
  writeFileSync(worker,job.replace('AGH=/data/adb/adblockpro',`AGH='${shellPath(agh)}'`).replace('DIR=/data/adb/bindhosts_personal/webui-jobs',`DIR='${shellPath(jobs)}'`).replaceAll('/system/bin/sh','bash'));
  writeFileSync(path.join(agh,'scripts/iptables.sh'),`#!/bin/sh\nprintf '%s\\n' "$1" >> '${shellPath(path.join(f.dir,'firewall'))}'\n`);chmodSync(path.join(agh,'scripts/iptables.sh'),0o755);
  const branchStart=bind.indexOf('  --dns-save|--dns-restore)');
  const branch=bind.slice(branchStart,bind.indexOf('  --resume)',branchStart));
  const execute=path.join(f.dir,'bindhosts.sh');
  writeFileSync(execute,`#!/bin/sh\nAGH='${shellPath(agh)}'\nBB='${shellPath(f.paths[family])}'\nABP_UPDATE_LOCKED=1\ncase "$1" in\n${branch}esac\n`);
  return { ...f,agh,jobs,worker,execute,run:(script,args)=>spawnSync('bash',[shellPath(script),...args],{encoding:'utf8',input:'',env:f.env(family)}) };
}
for(const family of ['KernelSU','Magisk','APatch']) test(`${family}: DNS read/test routes decode bounded payloads for the existing helper`,t=>{
  const f=fixture(t,family), wire='{"config":{"upstream_dns":["223.5.5.5"]}}', encoded=Buffer.from(wire).toString('base64');
  assert.equal(f.run(f.worker,['dns-info']).status,0);
  assert.equal(f.run(f.worker,['dns-test',encoded]).status,0);
  assert.equal(readFileSync(path.join(f.dir,'decoded'),'utf8'),wire);
  assert.notEqual(f.run(f.worker,['dns-test','not-valid;command']).status,0);
});
for(const code of [0,1,3]) test(`DNS mutation exit ${code} cleans only module redirects when rollback is unconfirmed`,t=>{
  const f=fixture(t,'Magisk',code),encoded=Buffer.from('{"revision":"test"}').toString('base64');
  const result=f.run(f.execute,['--dns-save',encoded]); assert.equal(result.status,code);
  assert.equal(existsSync(path.join(f.dir,'firewall')),code===3);
  if(code===3) assert.equal(readFileSync(path.join(f.dir,'firewall'),'utf8'),'disable\n');
});
test('DNS start metadata excludes the encoded DNS configuration from operation logs',t=>{
  const f=fixture(t), bb=f.paths.Magisk;
  writeFileSync(bb,readFileSync(bb,'utf8').replace('case "$1" in','case "$1" in\n  nohup) exit 0 ;;'));
  const encoded=Buffer.from('{"config":{"upstream_dns":["https://dns.example/?token=private"]}}').toString('base64');
  const r=f.run(f.worker,['start','123','--dns-save',encoded]);assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(path.join(f.jobs,'123.action'),'utf8'),'--dns-save\n\n');
  assert.doesNotMatch(readFileSync(path.join(f.jobs,'123.log'),'utf8'),/private|token|config/);
  for(const action of ['start','worker','execute'])assert.notEqual(f.run(f.worker,[action,'124','--dns-save','not-valid;command']).status,0);
});
