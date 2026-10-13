import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/kernelsu.js', import.meta.url), 'utf8').replace('export function', 'function');

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
