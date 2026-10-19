import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {rootFixture, shellPath} from './shell-fixture.mjs';

const fn = readFileSync(new URL('../webui-config.sh', import.meta.url), 'utf8').match(/save_personal_domain\(\) \{[\s\S]*?\n\}/)[0];
for (const recoveryFails of [false, true]) test(`manual list move preserves recoverable originals when rename fails; recovery failure=${recoveryFails}`, t => {
  const f = rootFixture(t);
  const before = {blacklist:'# old block\nads.example\n', whitelist:'keep.example\n'};
  for (const [kind, text] of Object.entries(before)) writeFileSync(path.join(f.dir, kind + '.txt'), text);
  const script = path.join(f.dir, 'move.sh');
  writeFileSync(script, [
    'umask 077', 'DIR=' + shellPath(f.dir), 'BB=env',
    'mv() { case "$1" in */whitelist.next) return 1 ;; esac; command mv "$@"; }',
    ...(recoveryFails ? ['cp() { case "$2" in */blacklist.before) return 1 ;; esac; command cp "$@"; }'] : []),
    fn, 'save_personal_domain whitelist ads.example',
  ].join('\n'));
  const r = spawnSync('bash', [shellPath(script)], {encoding:'utf8'});
  assert.equal(r.status, 1, r.stderr);
  const stages = readdirSync(f.dir).filter(name => name.startsWith('.personal-edit.'));
  if (recoveryFails) {
    assert.equal(stages.length, 1);
    for (const [kind,text] of Object.entries(before)) assert.equal(readFileSync(path.join(f.dir, stages[0], kind + '.before'), 'utf8'), text);
    assert.match(r.stderr, /原名单备份保留/);
  } else {
    assert.deepEqual(stages, []);
    for (const [kind,text] of Object.entries(before)) assert.equal(readFileSync(path.join(f.dir, kind + '.txt'), 'utf8'), text);
  }
});
