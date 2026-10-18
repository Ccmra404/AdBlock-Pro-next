import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/, '').replace(/\ninit\(\);/, '\n');
const jobSource = readFileSync(new URL('../webui-job.sh', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../customize.sh', import.meta.url), 'utf8');
const debugScript = readFileSync(new URL('../scripts/adb-debug.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/debug-release.yml', import.meta.url), 'utf8');
const debugDocs = readFileSync(new URL('../docs/adb-debug.md', import.meta.url), 'utf8');

function harness(debugBuild = false) {
  const pending = [], storage = new Map();
  const context = vm.createContext({
    TextEncoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    document: { documentElement: {}, body: {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { ABP_DEBUG_BUILD: debugBuild },
    exec: command => new Promise(resolve => pending.push({ command, resolve })),
    setTimeout, clearTimeout, setInterval() { return 1; }, requestAnimationFrame() {}, cancelAnimationFrame() {},
  });
  vm.runInContext(appSource, context);
  return { context, pending, ...vm.runInContext('({state,loadObservationResult,observationDebugText,observationPanel})', context) };
}

test('debug summary contains only aggregated domains and validated fields', () => {
  const h = harness(true);
  const text = h.observationDebugText([
    { domain: 'ads.example', count: 2, time: 1700000001000, reason: 'FilteredBlackList', filterId: 123 },
    { domain: 'api.example', count: 1, time: 1700000002000, reason: 'Bad\nInjected', filterId: '123\ncat' },
    { domain: 'bad;domain.example', count: 99 },
  ], 1700000000000, true);
  assert.match(text, /domain_count\t2/);
  assert.match(text, /included_count\t2/);
  assert.match(text, /source_truncated\t1/);
  assert.match(text, /ads\.example\t2\t1700000001\tFilteredBlackList\t123/);
  assert.match(text, /api\.example\t1\t1700000002\t\t/);
  assert.doesNotMatch(text, /bad;domain|client|192\.0\.2\.1|com\.private\.app/);
});

test('Debug build saves the sanitized observation before the temporary raw result is cleaned', async () => {
  const h = harness(true), startedAt = 1700000000000;
  h.state.observation = { id: '123', startedAt, active: false, appLabel: 'Private App', appPackage: 'com.private.app' };
  const loading = h.loadObservationResult('123');
  const fetch = h.pending.shift();
  assert.match(fetch.command, /observe-result 123/);
  const result = [{ time: new Date(startedAt + 1000).toISOString(), question: { name: 'ads.example' }, reason: 'FilteredBlackList', filterId: 7, client: '192.0.2.1' }];
  fetch.resolve({ errno: 0, stdout: JSON.stringify(result) });
  await new Promise(setImmediate);
  const save = h.pending.shift();
  assert.match(save.command, /debug-save/);
  const encoded = save.command.match(/debug-save '([^']+)'$/)[1];
  const payload = Buffer.from(encoded, 'base64').toString('utf8');
  assert.match(payload, /ads\.example\t1\t1700000001\tFilteredBlackList\t7/);
  assert.doesNotMatch(payload, /Private App|com\.private\.app|192\.0\.2\.1|"question"/);
  save.resolve({ errno: 0, stdout: 'saved' });
  await new Promise(setImmediate);
  const clean = h.pending.shift();
  assert.match(clean.command, /observe-clean 123/);
  clean.resolve({ errno: 0, stdout: 'cleaned' });
  await loading;
});

test('formal build skips debug persistence and shows no debug-only notice', async () => {
  const h = harness(false), startedAt = 1700000000000;
  h.state.observation = { id: '123', startedAt, active: false };
  const loading = h.loadObservationResult('123');
  h.pending.shift().resolve({ errno: 0, stdout: JSON.stringify([{ time: new Date(startedAt + 1000).toISOString(), question: { name: 'ads.example' } }]) });
  await new Promise(setImmediate);
  const clean = h.pending.shift();
  assert.match(clean.command, /observe-clean 123/);
  clean.resolve({ errno: 0, stdout: 'cleaned' });
  await loading;
  assert.doesNotMatch(h.observationPanel(), /调试版会在本机保留/);
});

test('debug storage is opt-in, validates a bounded TSV, and uses private atomic files', () => {
  assert.match(jobSource, /\[ -f "\$MODDIR\/debug-build" \] \|\| exit 0/);
  assert.match(jobSource, /\[ \$\{#encoded\} -le 100000 \]/);
  assert.match(jobSource, /chmod 700 "\$debug_dir"/);
  assert.match(jobSource, /chmod 600 "\$tmp" && mv -f "\$tmp"/);
  assert.match(jobSource, /Invalid debug observation summary/);
  assert.match(debugScript, /latest-observation\.tsv/);
  assert.match(debugScript, /dns_listener\|dns_listener_udp\|dns_listener_tcp\|dns_api/);
  assert.match(debugScript, /86400/);
  assert.match(installer, /scripts\/adb-debug\.sh" -d "\$MODPATH/);
  assert.match(installer, /unzip -l "\$ZIPFILE" \| grep -Eq/);
  assert.doesNotMatch(installer, /unzip -Z1/);
  assert.doesNotMatch(debugScript, /debug\.log|AdGuardHome\.yaml|admin\.auth|ip addr|iptables -t nat -L/);
});

test('Debug ZIP is attached only after a successful main release and cannot overwrite assets', () => {
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(workflow, /debug-build\.js/);
  assert.match(workflow, /AdBlock-Pro-\$\{TAG\}-debug-arm64\.zip/);
  assert.match(workflow, /gh release upload "\$TAG"/);
  assert.match(workflow, /release assets are immutable/);
  assert.doesNotMatch(workflow, /gh release create|--clobber|^\s+push:/im);
  assert.match(debugDocs, /作为单独附件加入对应的 GitHub Release/);
  assert.match(debugDocs, /文件名带 `-debug`/);
});
