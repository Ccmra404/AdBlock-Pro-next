import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';
function fixture(t) {
 const f=rootFixture(t);f.addBusybox('Magisk');
 const runtime=path.join(f.dir,'runtime'),state=path.join(f.dir,'state');mkdirSync(path.join(runtime,'bin'),{recursive:true});mkdirSync(path.join(runtime,'scripts'),{recursive:true});
 writeFileSync(path.join(runtime,'bin/AdGuardHome.yaml'),'querylog:\n  file_enabled: false\n');
 writeFileSync(path.join(runtime,'scripts/detach.sh'),'exit 0\n');chmodSync(path.join(runtime,'scripts/detach.sh'),0o755);
 const original=readFileSync(new URL('../bindhosts.sh',import.meta.url),'utf8');
 const functions=original.slice(0,original.lastIndexOf('\ncase "$1" in\n')).replaceAll('/data/adb/adblockpro',shellPath(runtime)).replaceAll('/data/adb/bindhosts_personal',shellPath(state));
 const script=path.join(f.dir,'bindhosts.sh'),trace=path.join(f.dir,'trace');
 writeFileSync(script,functions+`
api() {
 printf '%s %s %s\\n' "$1" "$2" "$3" >> "$TRACE"
 case "$2" in
 /querylog_info) printf '{"interval":24,"enabled":false,"anonymize_client_ip":false}' ;;
 /querylog_config) return 0 ;;
 /querylog*) printf '{"data":[]}' ;;
 esac
}
cmd() { [ "$NO_ACTIVITY" != 1 ] && echo com.coolapk.market/.MainActivity; }
am() { printf 'am %s\\n' "$*" >> "$TRACE"; if [ "$LAUNCH_ERROR" = 1 ] && [ "$1" = start ]; then echo 'Error: unavailable'; fi; }
sleep() { :; }
observe_capture "$1" "$2" "$3"
`);
 const run=(seconds='10',pkg='com.coolapk.market',extra={})=>spawnSync('bash',[shellPath(script),seconds,'123',pkg],{env:{...f.env('Magisk'),TRACE:shellPath(trace),...extra},encoding:'utf8',timeout:10000});
 return {run,trace,state};
}
test('ten-second observation logs before reopening the selected app and restores preferences',t=>{
 const f=fixture(t),r=f.run();assert.equal(r.status,0,r.stderr);
 const trace=readFileSync(f.trace,'utf8');assert.match(trace,/anonymize_client_ip":true[\s\S]*am force-stop[\s\S]*am start[\s\S]*enabled":false/);
 assert.equal(existsSync(path.join(f.state,'observations/active')),false);assert.equal(existsSync(path.join(f.state,'observations/lock')),false);
});
test('Android zero-exit Error launch output fails safely and restores query logging',t=>{
 const f=fixture(t),r=f.run('5','com.coolapk.market',{LAUNCH_ERROR:'1'});assert.notEqual(r.status,0);
 assert.match(readFileSync(f.trace,'utf8'),/am start[\s\S]*enabled":false/);
 assert.equal(existsSync(path.join(f.state,'observations/active')),false);
});
test('invalid package, missing launcher and unsupported duration cannot alter query-log settings',t=>{
 for(const args of [['10','com.coolapk;bad'],['10','com.coolapk.market',{NO_ACTIVITY:'1'}],['2','com.coolapk.market']]) {
  const f=fixture(t),r=f.run(...args);assert.notEqual(r.status,0);assert.equal(existsSync(f.trace),false);
 }
});

test('pre-existing disk query logging is refused without launching an app or changing preferences',t=>{
 const f=fixture(t);
 const yaml=path.join(path.dirname(f.trace),'runtime/bin/AdGuardHome.yaml');
 writeFileSync(yaml,'querylog:\n  file_enabled: true\n');
 const r=f.run(); assert.notEqual(r.status,0); assert.match(r.stderr,/磁盘/); assert.equal(existsSync(f.trace),false);
});
