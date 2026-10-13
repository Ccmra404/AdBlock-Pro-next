import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath, rootFixture } from './shell-fixture.mjs';

const source = readFileSync(new URL('../webui-job.sh', import.meta.url), 'utf8');

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
