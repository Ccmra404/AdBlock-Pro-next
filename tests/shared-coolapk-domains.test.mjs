import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('shared snapshot covers observed Coolapk ad endpoints without blocking app services', () => {
  const text = readFileSync(new URL('../rules/shared-app-domains.txt', import.meta.url), 'utf8');
  const domains = text.split(/\r?\n/).filter(row => row && !row.startsWith('#'));
  assert.equal(new Set(domains).size, domains.length);
  for (const domain of [
    'api-access.pangolin-sdk-toutiao1.com',
    'gromore.pangolin-sdk-toutiao.com',
    'open.e.kuaishou.com',
    'sf6-fe-tos.pglstatp-toutiao.com',
    'lf3-sf-be-tos-sign.pglstatp-toutiao.com',
    'lf6-sf-be-tos-sign.pglstatp-toutiao.com',
    'lf9-sf-be-tos-sign.pglstatp-toutiao.com',
    'v26-be-pack.pglstatp-toutiao.com',
    'youku-dsp.youku.com',
  ]) assert.ok(domains.includes(domain), `Missing reviewed ad endpoint: ${domain}`);
  for (const domain of ['coolapk.com', 'api.coolapk.com', 'api2.coolapk.com', 'avatar.coolapk.com', 'image.coolapk.com', 'youku.com']) {
    assert.ok(!domains.includes(domain), `App/content domain must remain available: ${domain}`);
  }
});
