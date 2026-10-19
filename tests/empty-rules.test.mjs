import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {rootFixture, shellPath} from './shell-fixture.mjs';

const source = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
const update = source.slice(source.indexOf('update_rules() {'), source.indexOf('\ndiagnose() {'));
const count = source.slice(source.indexOf('rules_count() {'), source.indexOf('\nhistory_text() {'));
for (const [name, sources, personal, status, success] of [
  ['removed sources and empty personal lists stay empty', 'mode\tbalanced\n', 0, '{"filters":[]}', true],
  ['native AdGuard Home null filter slice is intentionally empty', '', 0, '{"filters":null,"whitelist_filters":null}', true],
  ['disabled sources also allow empty filters', 'source\tcustom\tFeed\thttps://feed.example\tdisabled\n', 0, '{"filters": [\n ]}', true],
  ['an enabled source with no rules still rolls back', 'source\tcustom\tFeed\thttps://feed.example\tenabled\n', 0, '{"filters":[]}', false],
  ['enabled source still rejects a null filter slice', 'source\tcustom\tFeed\thttps://feed.example\tenabled\n', 0, '{"filters":null}', false],
  ['missing expected personal rules still rolls back', '', 1, '{"filters":[]}', false],
  ['an invalid filter status is not accepted as intentionally empty', '', 0, '{}', false],
  ['a null prefix is not an empty filter slice', '', 0, '{"filters":nullish}', false],
]) {
  test(name, t => {
    const root = rootFixture(t); root.addBusybox('Magisk');
    const state = path.join(root.dir, 'state'); mkdirSync(state);
    writeFileSync(path.join(root.dir, 'sources'), sources);
    writeFileSync(path.join(root.dir, 'status'), status);
    writeFileSync(path.join(root.dir, 'webui-config.sh'), '#!/bin/sh\ncat "${0%/*}/sources"\n');
    const script = path.join(root.dir, 'update.sh');
    writeFileSync(script, [
      'MODDIR=' + shellPath(root.dir), 'STATE=' + shellPath(state), 'BB=' + shellPath(root.paths.Magisk),
      'RULE_STORE=/unused',
      'api() { if [ "$2" = /filtering/status ]; then cat "$MODDIR/status"; fi; return 0; }',
      'save_snapshot() { return 0; }', 'sync_sources() { return 0; }',
      `sync_personal_filter() { USER_RULE_COUNT=${personal}; }`,
      'update_failed() { echo ROLLBACK >&2; }', count, update, 'update_rules',
    ].join('\n'));
    const r = spawnSync('bash', [shellPath(script)], {encoding:'utf8', env:root.env('Magisk')});
    assert.equal(r.status, success ? 0 : 1, r.stderr + r.stdout);
    assert.match(r.stdout, /下载并校验规则源/);
    assert.equal(existsSync(path.join(state, 'last-update')), success);
    if (success) assert.doesNotMatch(r.stderr, /ROLLBACK/);
    else assert.match(r.stderr, /ROLLBACK/);
  });
}
