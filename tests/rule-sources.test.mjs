import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const original = readFileSync(new URL('../webui-config.sh', import.meta.url), 'utf8');
const base = 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
const awaAds = 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt';
const antiAd = 'https://anti-ad.net/easylist.txt';
const custom = 'https://example.org/filter.txt';
const shared = 'shared';

function fixture(t, { light = '', balanced = '', strict = '', customSources = '' } = {}) {
  const root = rootFixture(t);
  root.addBusybox('Magisk');
  const dir = root.dir;
  mkdirSync(path.join(dir, 'profiles'));
  for (const [profile, content] of Object.entries({ light, balanced, strict }))
    writeFileSync(path.join(dir, 'profiles', profile + '.txt'), content);
  writeFileSync(path.join(dir, 'profiles-initialized'), 'initialized\n');
  writeFileSync(path.join(dir, 'custom-sources.txt'), customSources);
  writeFileSync(path.join(dir, 'blocking-mode'), 'strict\n');
  const script = path.join(dir, 'webui-config.sh');
  writeFileSync(script, original.replace('DIR=/data/adb/bindhosts_personal', 'DIR=' + shellPath(dir)));
  const run = (action, ...args) => {
    const r = spawnSync('bash', [shellPath(script), action, ...args], { encoding: 'utf8', timeout: 12000, env: root.env('Magisk') });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const list = () => {
    const r = run('list-sources', 'balanced');
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').map(x => x.split('\t'));
    return lines.slice(1).map(row => ({ id: row[1], label: row[2], url: row[3], enabled: row[4], configured: row[5], removable: row[6] }));
  };
  return { dir, run, list };
}

test('legacy selected profile migrates once to one editable source list without deleting old data', t => {
  const f = fixture(t, { balanced: awaAds + '\n', strict: antiAd + '\n' + custom + '\n', customSources: custom + '\n' });
  const sources = f.list();
  assert.equal(sources.find(x => x.url === base).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === awaAds).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === antiAd).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === custom).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === shared).enabled, 'enabled');
  assert.ok(existsSync(path.join(f.dir, 'profiles', 'strict.txt')));
  assert.deepEqual(readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8').trim().split('\n').sort(), [base, awaAds, antiAd, custom, shared].sort());
});

test('every bundled source and shared rules can be disabled and removed', t => {
  const f = fixture(t);
  assert.equal(f.run('set-source', base, 'off', 'balanced').status, 0);
  assert.equal(f.run('set-source', shared, 'off', 'balanced').status, 0);
  assert.equal(f.list().find(x => x.url === base).enabled, 'disabled');
  assert.equal(f.list().find(x => x.url === shared).enabled, 'disabled');
  assert.equal(f.run('remove-source', base).status, 0);
  assert.equal(f.run('remove-source', shared).status, 0);
  assert.equal(f.list().find(x => x.url === base).configured, 'catalog');
  assert.equal(f.list().find(x => x.url === shared).configured, 'catalog');
});

test('custom subscriptions can be added, renamed, removed, and re-added with a name', t => {
  const f = fixture(t);
  const add = f.run('add-source', custom, '我的过滤表');
  assert.equal(add.status, 0, add.stderr + add.stdout);
  assert.equal(f.list().find(x => x.url === custom).label, '我的过滤表');
  assert.equal(f.run('rename-source', custom, '新名称').status, 0);
  assert.equal(f.list().find(x => x.url === custom).label, '新名称');
  assert.equal(f.run('remove-source', custom).status, 0);
  assert.equal(f.list().some(x => x.url === custom), false);
  assert.equal(f.run('add-source', custom, '重新导入').status, 0);
  assert.equal(f.list().find(x => x.url === custom).label, '重新导入');
});

test('built-in source names can be customized and malformed names are rejected', t => {
  const f = fixture(t);
  const rename = f.run('rename-source', base, '我的 10007');
  assert.equal(rename.status, 0, rename.stderr + rename.stdout);
  assert.equal(f.list().find(x => x.url === base).label, '我的 10007');
  const invalid = f.run('rename-source', base, 'bad\tname');
  assert.notEqual(invalid.status, 0, invalid.stderr + invalid.stdout + JSON.stringify(invalid));
});

test('subscription URLs can be changed without changing enabled state or losing a custom name', t => {
  const replacement = 'https://mirror.example/ads.txt';
  const f = fixture(t, { strict: custom + '\n', customSources: custom + '\n' });
  assert.equal(f.run('rename-source', custom, '我的规则').status, 0);
  const result = f.run('edit-source', custom, replacement);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.list().some(x => x.url === custom), false);
  assert.deepEqual(f.list().find(x => x.url === replacement), {
    id: 'custom', label: '我的规则', url: replacement, enabled: 'enabled', configured: 'configured', removable: 'removable',
  });
  assert.doesNotMatch(readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8'), /example\.org/);
  assert.match(readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8'), /mirror\.example/);
  assert.doesNotMatch(readFileSync(path.join(f.dir, 'custom-sources.txt'), 'utf8'), /example\.org/);
  assert.match(readFileSync(path.join(f.dir, 'custom-sources.txt'), 'utf8'), /mirror\.example/);
});

test('subscription URL edits reject invalid or duplicate targets without mutating existing sources', t => {
  const replacement = 'https://rules.example/other.txt';
  const f = fixture(t, { strict: custom + '\n' + replacement + '\n', customSources: custom + '\n' + replacement + '\n' });
  const invalid = f.run('edit-source', custom, 'http://insecure.example/list.txt');
  assert.notEqual(invalid.status, 0);
  const duplicate = f.run('edit-source', custom, replacement);
  assert.notEqual(duplicate.status, 0);
  assert.equal(readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8').includes(custom), true);
});

test('empty legacy profiles still migrate to the previous default subscriptions and shared library', t => {
  const f = fixture(t);
  const sources = f.list();
  assert.equal(sources.find(x => x.url === base).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === awaAds).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === shared).enabled, 'enabled');
  assert.equal(sources.filter(x => x.enabled === 'enabled').length, 3);
  assert.ok(sources.every(x => x.removable === 'removable'));
});
