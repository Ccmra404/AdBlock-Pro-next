import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

for (const family of ['KernelSU', 'Magisk', 'APatch']) {
  test(`${family}: application labels use a bounded read-only helper without the configuration lock`, t => {
    const f = rootFixture(t); f.addBusybox(family);
    const helper = path.join(f.dir, 'adblock-apps.dex');
    const processFile = path.join(f.dir, 'app_process');
    const script = path.join(f.dir, 'webui-config.sh');
    const trace = path.join(f.dir, 'trace');
    writeFileSync(helper, 'fixture');
    writeFileSync(processFile, '#!/bin/sh\n[ "$CLASSPATH" = "$EXPECTED_HELPER" ] || exit 3\nprintf \'[{"packageName":"com.coolapk.market","appLabel":"酷安"}]\\n\'\n');
    chmodSync(processFile, 0o755);
    const busybox = f.paths[family];
    writeFileSync(busybox, readFileSync(busybox, 'utf8').replace('#!/bin/sh', '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TRACE"'));
    const state = path.join(f.dir, 'state'); mkdirSync(state);
    writeFileSync(script, readFileSync(new URL('../webui-config.sh', import.meta.url), 'utf8')
      .replaceAll('/data/adb/bindhosts_personal', shellPath(state))
      .replace('/data/adb/adblockpro/bin/adblock-apps.dex', shellPath(helper))
      .replace('/system/bin/app_process', shellPath(processFile)));
    const run = () => spawnSync('bash', [shellPath(script), 'application-labels'], {
      env: { ...f.env(family), TRACE: shellPath(trace), EXPECTED_HELPER: shellPath(helper) },
      encoding: 'utf8', timeout: 10000,
    });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].appLabel, '酷安');
    assert.match(readFileSync(trace, 'utf8'), /timeout 10 .*app_process \/system\/bin AppCatalogue/);
    assert.doesNotMatch(readFileSync(trace, 'utf8'), /flock -n/);
    assert.equal(existsSync(path.join(state, 'update.lock')), false);
    writeFileSync(helper, '');
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /helper is unavailable/);
    assert.equal(existsSync(path.join(state, 'update.lock')), false);
  });
}
