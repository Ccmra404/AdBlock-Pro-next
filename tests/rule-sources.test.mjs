import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const original = readFileSync(new URL('../webui-config.sh', import.meta.url), 'utf8');
const base = 'https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
const awaFull = 'https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt';
const oldBase = 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
const oldBaseCdn = 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward';
const oldBaseGcore = 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward';
const oldAwaFull = 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt';
const oldAwaFullGcore = 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt';
const oldAwaAds = 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt';
const oldAwaAdsGcore = 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt';
const antiAd = 'https://anti-ad.net/easylist.txt';
const custom = 'https://example.org/filter.txt';
const shared = 'shared';

test('manual rules reject a DNS label over 63 characters and preserve valid entries', t => {
  const f = fixture(t), accepted = 'a'.repeat(63) + '.example';
  assert.equal(f.run('add-blacklist', accepted).status, 0);
  const before = readFileSync(path.join(f.dir, 'blacklist.txt'), 'utf8');
  assert.notEqual(f.run('add-blacklist', 'a'.repeat(64) + '.example').status, 0);
  assert.equal(readFileSync(path.join(f.dir, 'blacklist.txt'), 'utf8'), before);
});

for (const kind of ['blacklist', 'whitelist']) {
  test(`manual ${kind} addition rejects an exact opposite-list entry without deleting it`, t => {
    const f = fixture(t);
    const opposite = kind === 'blacklist' ? 'whitelist' : 'blacklist';
    writeFileSync(path.join(f.dir, opposite + '.txt'), 'ADS.Example\r\n');
    const result = f.run('add-' + kind, 'ads.example');
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(readFileSync(path.join(f.dir, opposite + '.txt'), 'utf8'), 'ADS.Example\r\n');
    assert.equal(existsSync(path.join(f.dir, kind + '.txt')), false);
  });
}

function fixture(t, { light = '', balanced = '', strict = '', customSources = '', sourcesV2, sourceNames = '', profilesInitialized = true } = {}) {
  const root = rootFixture(t);
  root.addBusybox('Magisk');
  const dir = root.dir;
  mkdirSync(path.join(dir, 'profiles'));
  for (const [profile, content] of Object.entries({ light, balanced, strict }))
    writeFileSync(path.join(dir, 'profiles', profile + '.txt'), content);
  if (profilesInitialized) writeFileSync(path.join(dir, 'profiles-initialized'), 'initialized\n');
  writeFileSync(path.join(dir, 'custom-sources.txt'), customSources);
  if (sourcesV2 !== undefined) writeFileSync(path.join(dir, 'sources-v2.txt'), sourcesV2);
  if (sourceNames) writeFileSync(path.join(dir, 'source-names.tsv'), sourceNames);
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

test('legacy selected profile migrates once to the new base sources without deleting user subscriptions', t => {
  const f = fixture(t, { balanced: oldAwaAds + '\n', strict: antiAd + '\n' + custom + '\n', customSources: custom + '\n' });
  const sources = f.list();
  assert.equal(sources.find(x => x.url === base).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === awaFull).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === antiAd).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === custom).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === shared).enabled, 'enabled');
  assert.ok(existsSync(path.join(f.dir, 'profiles', 'strict.txt')));
  assert.deepEqual(readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8').trim().split('\n').sort(), [base, awaFull, antiAd, custom, shared].sort());
  assert.match(readFileSync(path.join(f.dir, 'profiles', 'balanced.txt'), 'utf8'), new RegExp(awaFull.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(readFileSync(path.join(f.dir, 'profiles', 'balanced.txt'), 'utf8'), /Adguard-Only\.Ads/);
});

test('existing source URLs migrate in place, preserve custom names and selections, and keep old optional sources', t => {
  const f = fixture(t, {
    sourcesV2: [oldBase, oldBaseCdn, oldBaseGcore, oldAwaFull, oldAwaFullGcore, oldAwaAds, oldAwaAdsGcore, antiAd, custom, shared].join('\n') + '\n',
    sourceNames: oldAwaAds + '\tMy AWA list\n' + custom + '\tCustom list\n',
    customSources: custom + '\n',
  });
  const sources = f.list();
  assert.equal(sources.find(x => x.url === base).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === awaFull).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === awaFull).label, 'My AWA list');
  assert.equal(sources.find(x => x.url === antiAd).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === custom).enabled, 'enabled');
  assert.equal(sources.some(x => [oldBase, oldBaseCdn, oldBaseGcore, oldAwaFull, oldAwaFullGcore, oldAwaAds, oldAwaAdsGcore].includes(x.url)), false);
  assert.equal(sources.filter(x => [base, awaFull, shared].includes(x.url)).length, 3);
  const migrated = readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8');
  assert.equal(sources.some(x => [oldBase, oldBaseCdn, oldBaseGcore].includes(x.url)), false);
  assert.doesNotMatch(migrated, /AWAvenue-Ads-Rule-Adguard-Only/);
  assert.match(migrated, /anti-ad\.net/);
  assert.match(readFileSync(path.join(f.dir, 'source-names.tsv'), 'utf8'), /My AWA list/);
});

test('removing bundled sources hides them from the source list and they can be imported again', t => {
  const f = fixture(t);
  assert.equal(f.run('set-source', base, 'off', 'balanced').status, 0);
  assert.equal(f.run('set-source', shared, 'off', 'balanced').status, 0);
  assert.equal(f.list().find(x => x.url === base).enabled, 'disabled');
  assert.equal(f.list().find(x => x.url === shared).enabled, 'disabled');
  assert.equal(f.run('remove-source', base).status, 0);
  assert.equal(f.run('remove-source', shared).status, 0);
  assert.equal(f.list().some(x => x.url === base), false);
  assert.equal(f.list().some(x => x.url === shared), false);
  assert.deepEqual(readFileSync(path.join(f.dir, 'removed-sources.txt'), 'utf8').trim().split('\n').sort(), [base, shared].sort());
  assert.equal(f.run('add-source', base, '10007').status, 0);
  assert.equal(f.run('set-source', shared, 'on', 'balanced').status, 0);
  assert.equal(f.list().find(x => x.url === base).enabled, 'enabled');
  assert.equal(f.list().find(x => x.url === shared).enabled, 'enabled');
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

test('fresh source catalog contains only 10007, full AWAvenue, and the shared library', t => {
  const f = fixture(t);
  const sources = f.list();
  assert.equal(sources.find(x => x.url === base).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === awaFull).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === shared).enabled, 'enabled');
  assert.equal(sources.length, 3);
  assert.equal(sources.filter(x => x.enabled === 'enabled').length, 3);
  assert.ok(sources.every(x => x.removable === 'removable'));
});

test('a fresh source setup does not inject the old anti-AD strict-profile default', t => {
  const f = fixture(t, { profilesInitialized: false });
  const sources = f.list();
  assert.deepEqual(sources.map(x => x.url).sort(), [base, awaFull, shared].sort());
  assert.doesNotMatch(readFileSync(path.join(f.dir, 'sources-v2.txt'), 'utf8'), /anti-ad\.net/);
});
