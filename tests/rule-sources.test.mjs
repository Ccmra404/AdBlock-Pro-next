import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { rootFixture, shellPath } from './shell-fixture.mjs';

const original = readFileSync(new URL('../webui-config.sh', import.meta.url), 'utf8');
const base = 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward';
const awaAds = 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt';
const antiAd = 'https://anti-ad.net/easylist.txt';
const custom = 'https://example.org/filter.txt';

function fixture(t, { light = '', balanced = '', strict = '', customSources = '' } = {}) {
  const root = rootFixture(t);
  root.addBusybox('Magisk');
  const dir = root.dir;
  mkdirSync(path.join(dir, 'profiles'));
  for (const [profile, content] of Object.entries({ light, balanced, strict }))
    writeFileSync(path.join(dir, 'profiles', profile + '.txt'), content);
  writeFileSync(path.join(dir, 'custom-sources.txt'), customSources);
  writeFileSync(path.join(dir, 'blocking-mode'), 'balanced\n');
  const script = path.join(dir, 'webui-config.sh');
  const patched = original
    .replace('DIR=/data/adb/bindhosts_personal', 'DIR=' + shellPath(dir));
  writeFileSync(script, patched);
  return profile => {
    const r = spawnSync('bash', [shellPath(script), 'list-sources', profile], { encoding: 'utf8', timeout: 12000, env: root.env('Magisk') });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').map(x => x.split('\t'));
    assert.deepEqual(lines[0], ['mode', profile]);
    return lines.slice(1).map(row => ({
      id: row[1], label: row[2], url: row[3], enabled: row[4], configured: row[5], removable: row[6],
    }));
  };
}

test('balanced source selection and custom URLs are preserved', t => {
  const fetch = fixture(t, { balanced: awaAds + '\n' + custom + '\n', customSources: custom + '\n' });
  const sources = fetch('balanced');
  const reward = sources.find(x => x.url === base);
  const ads = sources.find(x => x.url === awaAds);
  const extra = sources.find(x => x.url === custom);
  assert.equal(reward.id, '10007');
  assert.equal(reward.removable, 'base');
  assert.equal(reward.enabled, 'enabled');
  assert.equal(ads.id, 'awa');
  assert.equal(ads.enabled, 'enabled');
  assert.equal(extra.id, 'custom');
  assert.equal(extra.enabled, 'enabled');
  assert.equal(extra.removable, 'removable');
  assert.equal(sources.find(x => x.url === antiAd).enabled, 'disabled');
  assert.deepEqual(sources.map(x => x.url), [...sources.map(x => x.url)].sort());
});

test('switching from balanced to light cannot reuse the other profile enabled sources', t => {
  const fetch = fixture(t, { balanced: awaAds + '\n' + custom + '\n', customSources: custom + '\n' });
  const light = fetch('light');
  assert.equal(light.find(x => x.url === base).enabled, 'enabled');
  assert.equal(light.find(x => x.url === awaAds).enabled, 'disabled');
  assert.equal(light.find(x => x.url === custom).enabled, 'disabled');
  assert.equal(light.find(x => x.url === custom).configured, 'catalog');
});

test('empty profile files still output the complete catalog', t => {
  const fetch = fixture(t);
  const sources = fetch('strict');
  assert.equal(sources.length, 6);
  assert.equal(sources.filter(x => x.enabled === 'enabled').length, 1);
  assert.equal(sources.find(x => x.url === base).enabled, 'enabled');
  assert.equal(sources.find(x => x.url === antiAd).enabled, 'disabled');
});

test('list-sources no longer forks grep for each source row', () => {
  const body = original.slice(original.indexOf('  list-sources)\n'));
  assert.doesNotMatch(body, /\$BB"\s+grep\s+-Fxq/);
  assert.match(body, /FILENAME == ARGV\[1\]/);
});
