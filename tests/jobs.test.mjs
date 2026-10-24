import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath, rootFixture } from './shell-fixture.mjs';

const source = readFileSync(new URL('../webui-job.sh', import.meta.url), 'utf8');

test('application scope config forwards both arguments and records the numeric job ID', t => {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const jobs = path.join(root.dir, 'jobs'); mkdirSync(jobs);
  const script = path.join(root.dir, 'webui-job.sh');
  writeFileSync(script, source.replace('DIR=/data/adb/bindhosts_personal/webui-jobs', 'DIR=' + JSON.stringify(shellPath(jobs))));
  writeFileSync(path.join(root.dir, 'webui-config.sh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  const result = spawnSync('bash', [shellPath(script), 'config', 'app-filter-set', '0:com.example.app', 'off', '1791000000100'], {
    encoding: 'utf8', env: root.env('Magisk'), timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'app-filter-set\n0:com.example.app\noff\n');
  assert.equal(readFileSync(path.join(jobs, '1791000000100.action'), 'utf8'), 'app-filter-set\n0:com.example.app\n');
  assert.equal(readFileSync(path.join(jobs, '1791000000100.done'), 'utf8'), '0\n');
  const invalid = spawnSync('bash', [shellPath(script), 'config', 'app-filter-set', '0:com.example;id', 'off', '1791000000101'], {
    encoding: 'utf8', env: root.env('Magisk'), timeout: 10000,
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(path.join(jobs, '1791000000101.done')), false);
});

test('clearing operation logs preserves running jobs for poll', t => {
  const fixture = rootFixture(t);
  fixture.addBusybox('Magisk');
  const dir = mkdtempSync(path.join(tmpdir(), 'adblockpro-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(fixture.dir, 'webui-job.sh');
  const modified = source
    .replace('DIR=/data/adb/bindhosts_personal/webui-jobs', 'DIR=' + JSON.stringify(shellPath(dir)));
  writeFileSync(script, modified);

  const completed = '1791000000000';
  const running = '1791000000001';
  for (const suffix of ['log', 'done', 'action'])
    writeFileSync(path.join(dir, completed + '.' + suffix), 'completed');
  for (const suffix of ['log', 'action'])
    writeFileSync(path.join(dir, running + '.' + suffix), 'running');

  const result = spawnSync('bash', [shellPath(script), 'clear'], { encoding: 'utf8', env: fixture.env('Magisk') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /进行中任务/);
  assert.equal(existsSync(path.join(dir, completed + '.log')), false);
  assert.equal(existsSync(path.join(dir, completed + '.done')), false);
  assert.equal(existsSync(path.join(dir, running + '.log')), true);
  assert.equal(existsSync(path.join(dir, running + '.action')), true);
});

test('recent-full returns newest detailed operation logs with a bounded tail', t => {
  const fixture = rootFixture(t);
  fixture.addBusybox('Magisk');
  const dir = mkdtempSync(path.join(tmpdir(), 'adblockpro-jobs-full-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(fixture.dir, 'webui-job.sh');
  writeFileSync(script, source.replace('DIR=/data/adb/bindhosts_personal/webui-jobs', 'DIR=' + JSON.stringify(shellPath(dir))));
  writeFileSync(path.join(dir, '1791000000001.action'), '--update\n\n');
  writeFileSync(path.join(dir, '1791000000001.done'), '1\n');
  writeFileSync(path.join(dir, '1791000000001.log'), 'x'.repeat(5000) + 'latest error');
  writeFileSync(path.join(dir, '1791000000000.action'), 'diagnose\n\n');
  writeFileSync(path.join(dir, '1791000000000.done'), '0\n');
  writeFileSync(path.join(dir, '1791000000000.log'), 'older detail');

  const result = spawnSync('bash', [shellPath(script), 'recent-full'], { encoding: 'utf8', env: fixture.env('Magisk') });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.indexOf('1791000000001') < result.stdout.indexOf('1791000000000'));
  assert.match(result.stdout, /仅复制末尾 4 KiB/);
  assert.match(result.stdout, /latest error/);
  assert.match(result.stdout, /older detail/);
});

test('failed worker reports the action failure without falsely claiming a lock conflict', t => {
  const fixture = rootFixture(t);
  fixture.addBusybox('Magisk');
  const mod = path.join(fixture.dir, 'module');
  const dir = path.join(fixture.dir, 'jobs');
  mkdirSync(path.join(mod, 'scripts'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(mod, 'scripts', 'compat.sh'), readFileSync(fixture.compatFile, 'utf8'));
  writeFileSync(path.join(mod, 'bindhosts.sh'), '#!/bin/sh\necho "curl: (35) Recv failure: Connection reset by peer" >&2\nexit 1\n');
  const script = path.join(mod, 'webui-job.sh');
  const modified = source
    .replace('DIR=/data/adb/bindhosts_personal/webui-jobs', 'DIR=' + JSON.stringify(shellPath(dir)))
    .replaceAll('/system/bin/sh', '/bin/sh');
  writeFileSync(script, modified);
  const result = spawnSync('bash', [shellPath(script), 'worker', '1791000000002', '--update'], { encoding: 'utf8', env: fixture.env('Magisk'), timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(path.join(dir, '1791000000002.log'), 'utf8');
  assert.match(log, /curl: \(35\).*Connection reset by peer/);
  assert.match(log, /任务执行失败（退出码 1）；请查看上方具体错误/);
  assert.doesNotMatch(log, /another DNS operation is already running/);
});
