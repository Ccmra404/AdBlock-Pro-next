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

test('older WebUI hosts list user packages once and retain package labels as fallback',async()=>{
  let calls=0;
  const window={ksu:{exec(command,options,cb){calls++;assert.equal(command,'pm list packages -3 --user 0');window[cb](0,'package:com.coolapk.market\npackage:bad;cmd\n','');}}};
  const context=vm.createContext({window,Date,Promise,Error,setTimeout});vm.runInContext(source,context);
  assert.equal((await context.listApplications())[0].label,'com.coolapk.market');assert.equal(calls,1);
});
