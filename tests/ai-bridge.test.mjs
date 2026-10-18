import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t, family) {
  const f = rootFixture(t); f.addBusybox(family);
  const bin = path.join(f.dir, 'runtime/bin'); mkdirSync(bin, { recursive: true });
  const ai = path.join(bin, 'adblock-ai'), payload = path.join(f.dir, 'payload'), args = path.join(f.dir, 'args');
  writeFileSync(ai, '#!/bin/sh\nprintf "%s\\n" "$*" > "$ARGS_FILE"\ncase "$1" in configure|start) cat > "$PAYLOAD_FILE";; esac\nprintf \'{"configured":true}\\n\'\n'); chmodSync(ai, 0o755);
  const script = path.join(f.dir, 'webui-job.sh');
  writeFileSync(script, readFileSync(new URL('../webui-job.sh', import.meta.url), 'utf8').replaceAll('/data/adb/adblockpro', shellPath(path.join(f.dir, 'runtime'))).replaceAll('/data/adb/bindhosts_personal', shellPath(path.join(f.dir, 'private'))));
  return { f, payload, args, run: (...values) => spawnSync('bash', [shellPath(script), ...values], { env: { ...f.env(family), ARGS_FILE: shellPath(args), PAYLOAD_FILE: shellPath(payload) }, encoding: 'utf8', timeout: 5000 }) };
}
for (const family of ['KernelSU', 'Magisk', 'APatch']) test(family + ': AI config uses private stdin and bypasses DNS operation logging/lock', t => {
  const h = fixture(t, family), json = '{"key":"fixture-only-secret"}', encoded = Buffer.from(json).toString('base64');
  const r = h.run('ai-config', encoded); assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(h.payload, 'utf8'), json); assert.equal(readFileSync(h.args, 'utf8').trim(), 'configure');
  assert.doesNotMatch(r.stdout + r.stderr, /fixture-only-secret/);
  assert.equal(existsSync(path.join(h.f.dir, 'private/webui-jobs')), false);
  const start = h.run('ai-start', '123', Buffer.from('{"domains":["ads.example"]}').toString('base64'));
  assert.equal(start.status, 0, start.stderr); assert.equal(readFileSync(h.args, 'utf8').trim(), 'start 123');
  assert.equal(h.run('ai-poll', '123').status, 0);
  assert.equal(h.run('ai-clear').status, 0);
});
test('invalid AI payloads and traversal IDs are rejected before the helper runs', t => {
  const h = fixture(t, 'Magisk');
  for (const args of [['ai-config', 'x;bad'], ['ai-config', 'x'.repeat(24001)], ['ai-start', '../123', 'e30='], ['ai-poll', '1;sh'], ['ai-poll', '1'.repeat(21)]]) {
    assert.notEqual(h.run(...args).status, 0); assert.equal(existsSync(h.args), false);
  }
});
