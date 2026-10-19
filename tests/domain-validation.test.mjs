import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {rootFixture, shellPath} from './shell-fixture.mjs';

for (const file of ['webui-config.sh', 'bindhosts.sh']) test(`${file} enforces DNS label and total-length boundaries`, t => {
  const f = rootFixture(t); f.addBusybox('Magisk');
  const fn = readFileSync(new URL('../' + file, import.meta.url), 'utf8').match(/valid_domain\(\) \{[\s\S]*?\n\}/)[0];
  const script = path.join(f.dir, 'validate.sh');
  writeFileSync(script, 'BB=' + shellPath(f.paths.Magisk) + '\n' + fn + '\nvalid_domain "$1"');
  const total253 = [63,63,63,61].map(n => 'a'.repeat(n)).join('.');
  for (const [domain, valid] of [
    ['ADS.Example',true], ['a'.repeat(63) + '.example',true], [total253,true],
    ['a'.repeat(64) + '.example',false], [total253 + 'a',false], ['a..example',false], ['-ads.example',false],
  ]) {
    const r = spawnSync('bash', [shellPath(script), domain], {encoding:'utf8'});
    assert.equal(r.status, valid ? 0 : 1, `${domain}: ${r.stderr}`);
  }
});
