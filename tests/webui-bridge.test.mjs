import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/kernelsu.js', import.meta.url), 'utf8').replace(/^export /gm, '');

test('KernelSU-compatible hosts preserve exit status and clean callbacks', async () => {
  const window = { ksu: { exec(command, options, callback) {
    assert.equal(command, 'test-command');
    assert.equal(JSON.parse(options).cwd, '/data/adb');
    window[callback](7, 'output', 'error');
  } } };
  const context = vm.createContext({ window, Date, Promise, Error });
  vm.runInContext(source, context);
  const result = await context.exec('test-command', { cwd: '/data/adb' });
  assert.equal(result.errno, 7);
  assert.equal(result.stdout, 'output');
  assert.equal(result.stderr, 'error');
  assert.equal(Object.keys(window).length, 1);
});

test('a regular browser explains Magisk needs a compatible WebUI host', async () => {
  const context = vm.createContext({ window: {}, Date, Promise, Error });
  vm.runInContext(source, context);
  await assert.rejects(context.exec('test-command'), /Magisk.*宿主/);
});

test('native application catalogue supplies labels, deduplicates and rejects malformed package IDs', async()=>{
  const window={ksu:{listPackages:()=>JSON.stringify(['com.coolapk.market','com.coolapk.market','bad;cmd']),getPackagesInfo:()=>JSON.stringify([{packageName:'com.coolapk.market',appLabel:'酷安'}])}};
  const context=vm.createContext({window,Date,Promise,Error,setTimeout});vm.runInContext(source,context);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.listApplications())),[{packageName:'com.coolapk.market',label:'酷安'}]);
});

test('older WebUI hosts keep package search when the label helper is unavailable',async()=>{
  let calls=0;
  const window={ksu:{exec(command,options,cb){calls++;if(command==='pm list packages -3 --user 0')window[cb](0,'package:com.coolapk.market\npackage:bad;cmd\n','');else window[cb](1,'','missing helper');}}};
  const context=vm.createContext({window,Date,Promise,Error,setTimeout});vm.runInContext(source,context);
  assert.equal((await context.listApplications())[0].label,'com.coolapk.market');assert.equal(calls,2);
});

test('Magisk standalone hosts without package APIs resolve Chinese labels locally',async()=>{
  const commands=[];
  const window={ksu:{exec(command,options,cb){
    commands.push(command);
    const out=command.startsWith('pm ')?'package:com.coolapk.market\npackage:com.example.app\n':JSON.stringify([
      {packageName:'com.coolapk.market',appLabel:'酷安'},
      {packageName:'com.example.app',appLabel:'示例 "App"\n'},
      {packageName:'bad;cmd',appLabel:'invalid'},
      {packageName:'com.not.installed',appLabel:'not installed'}
    ]);
    window[cb](0,out,'');
  }}};
  const context=vm.createContext({window,Date,Promise,Error,setTimeout});vm.runInContext(source,context);
  const apps=JSON.parse(JSON.stringify(await context.listApplications()));
  assert.equal(apps.length,2);
  assert.equal(apps.find(x=>x.packageName==='com.coolapk.market').label,'酷安');
  assert.equal(apps.find(x=>x.packageName==='com.example.app').label,'示例 "App"\n');
  assert.equal(commands.filter(x=>x.includes('application-labels')).length,1);
});

test('partial native metadata only fills missing labels and bounds label lengths',async()=>{
  let calls=0;
  const window={ksu:{listPackages:()=>JSON.stringify(['com.coolapk.market','com.example.app']),getPackagesInfo:()=>JSON.stringify([{packageName:'com.example.app',appLabel:'原生名称'}]),exec(command,options,cb){
    calls++;
    window[cb](0,JSON.stringify([{packageName:'com.coolapk.market',appLabel:'酷'.repeat(300)},{packageName:'com.example.app',appLabel:'替换名称'}]),'');
  }}};
  const context=vm.createContext({window,Date,Promise,Error,setTimeout});vm.runInContext(source,context);
  const apps=await context.listApplications();
  assert.equal(apps.find(x=>x.packageName==='com.coolapk.market').label.length,255);
  assert.equal(apps.find(x=>x.packageName==='com.example.app').label,'原生名称');
  assert.equal(calls,1);
});

test('invalid helper responses do not break package selection',async()=>{
  for(const response of ['not JSON','{}','[null,{}, {"packageName":"com.coolapk.market","appLabel":42}]']) {
    const window={ksu:{listPackages:()=>JSON.stringify(['com.coolapk.market']),exec(command,options,cb){window[cb](0,response,'');}}};
    const context=vm.createContext({window,Date,Promise,Error,setTimeout});vm.runInContext(source,context);
    assert.equal((await context.listApplications())[0].label,'com.coolapk.market');
  }
});
