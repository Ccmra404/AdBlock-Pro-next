import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/, '')
  .replace(/\ninit\(\);[\s\S]*$/, '\n');

function harness() {
  const pending = [];
  const timers = [];
  const controls = [];
  const toastNode = {};
  const storage = new Map();
  const document = {
    documentElement: {},
    body: {},
    hidden: false,
    addEventListener() {},
    querySelector(selector) { return selector === '#toast' ? toastNode : null; },
    querySelectorAll() { return controls; },
  };
  const context = vm.createContext({
    document,
    localStorage: {
      getItem(k) { return storage.get(k) ?? null; },
      setItem(k, v) { storage.set(k, String(v)); },
      removeItem(k) { storage.delete(k); },
    },
    window: {},
    exec(command) { return new Promise(resolve => pending.push({ command, resolve })); },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    setInterval() {},
  });
  vm.runInContext(source, context);
  const methods = vm.runInContext(
    '({ state, refreshStatus, loadSources, loadList, loadLogs, monitorJob, summaryText, memoryView, homePage, setBusy, nextJobId, progress, startJob })', context);
  return { ...methods, pending, controls, timers, context };
}
const status = (state, mode = 'balanced') =>
  ({ errno: 0, stdout: 'state=' + state + ' blocked=25 mode=' + mode + '\nfiltering_enabled=true' });
const sources = url => ({ errno: 0, stdout: 'source\t10007\tSource\t' + url + '\tenabled\tconfigured\tbase' });

test('unreadable, zero or inconsistent RSS never renders as 0.0 MB', () => {
  const h = harness();
  for (const rss of ['0', '', undefined, 'unavailable', '-1', 'NaN']) {
    h.state.status = { state: 'active', dns_rss_kb: rss };
    assert.equal(h.memoryView().value, '—');
    assert.doesNotMatch(h.homePage(), /0\.0 <span/);
  }
  h.state.status = { dns_rss_kb: '2300', dns_pss_kb: '25484' };
  assert.equal(h.memoryView().value, '—');
});

test('memory labels distinguish approximate RSS from a dated exact diagnostic sample', () => {
  const h = harness();
  h.state.status = { dns_rss_kb: '2300', dns_mem_source: 'status_estimate' };
  assert.equal(h.memoryView().value, '2.2');
  assert.match(h.memoryView().label, /估计/);
  h.state.status = { dns_rss_kb: '32768', dns_pss_kb: '25484', dns_mem_source: 'rollup_sample', dns_mem_sampled_at: '1791691200' };
  assert.equal(h.memoryView().value, '32.0');
  assert.match(h.memoryView().label, /诊断采样/);
  assert.match(h.memoryView().label, /PSS/);
});

test('healthy core with user-disabled takeover remains running, not faulty', () => {
  const h = harness();
  h.state.status = { state: 'bypassed', dns_core_running: '1', dns_listener: '1', dns_health: 'takeover_off', dns_takeover: 'off', dns_redirect: '0' };
  assert.match(h.summaryText()[0], /已关闭系统接管/);
  assert.match(h.homePage(), /DNS 运行中/);
  assert.doesNotMatch(h.summaryText().join(' '), /故障|未完全就绪/);
});

test('listener and firewall failures are not presented as intentional bypass', () => {
  const h = harness();
  h.state.status = { state: 'degraded', dns_core_running: '1', dns_listener: '0', dns_health: 'listener_failed', dns_takeover: 'off', dns_redirect: '0' };
  assert.match(h.summaryText()[0], /监听异常/);
  h.state.status = { state: 'degraded', dns_core_running: '1', dns_listener: '1', dns_health: 'takeover_failed', dns_takeover: 'on', dns_redirect: '0' };
  assert.match(h.summaryText()[0], /接管未成功/);
});

test('simultaneous status reads share one native call', async () => {
  const h = harness();
  const a = h.refreshStatus(true), b = h.refreshStatus(true);
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve(status('active'));
  await Promise.all([a, b]);
  assert.equal(h.state.status.state, 'active');
});

test('stale status responses never overwrite fresh responses', async () => {
  const h = harness();
  const old = h.refreshStatus(true), fresh = h.refreshStatus(true, true);
  const a = h.pending.shift(), b = h.pending.shift();
  b.resolve(status('paused', 'light'));
  await fresh;
  a.resolve(status('active', 'strict'));
  await old;
  assert.equal(h.state.status.state, 'paused');
});

test('rapid profile switching discards stale responses', async () => {
  const h = harness();
  h.state.profileEditor = 'light';
  const first = h.loadSources('light');
  h.state.profileEditor = 'balanced';
  const second = h.loadSources('balanced');
  const a = h.pending.shift(), b = h.pending.shift();
  b.resolve(sources('balanced-source'));
  await second;
  a.resolve(sources('light-source'));
  await first;
  assert.equal(h.state.sources[0].url, 'balanced-source');
});

test('profile refresh retains existing rows until new results arrive', async () => {
  const h = harness();
  h.state.profileEditor = 'balanced';
  const first = h.loadSources('balanced');
  h.pending.shift().resolve(sources('original-source'));
  await first;
  vm.runInContext("sourceCache.delete('balanced')", h.context);
  const next = h.loadSources('balanced');
  assert.equal(h.state.sources[0].url, 'original-source');
  h.pending.shift().resolve(sources('updated-source'));
  await next;
  assert.equal(h.state.sources[0].url, 'updated-source');
});

test('a job keeps previously disabled controls disabled', () => {
  const h = harness();
  const permanent = { disabled: true, dataset: {} };
  const ordinary = { disabled: false, dataset: {} };
  h.controls.push(permanent, ordinary);
  h.setBusy(true);
  assert.equal(ordinary.disabled, true);
  h.setBusy(false);
  assert.equal(permanent.disabled, true);
  assert.equal(ordinary.disabled, false);
});

test('progress is retained in state for page changes', () => {
  const h = harness();
  h.progress('更新规则', '12 秒');
  assert.equal(h.state.progress.stage, '更新规则');
  assert.equal(h.state.progress.result, 'running');
});

test('task IDs stay unique even in the same millisecond', () => {
  const h = harness();
  const a = h.nextJobId(), b = h.nextJobId();
  assert.notEqual(a, b);
  assert.match(a, /^\d{1,20}$/);
  assert.match(b, /^\d{1,20}$/);
});

test('second asynchronous job is rejected before the first native call completes', async () => {
  const h = harness();
  const first = h.startJob('--diagnose');
  await assert.rejects(h.startJob('--update'), /已有后台任务/);
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve({ errno: 0, stdout: 'started' });
  await first;
  assert.equal(h.state.job.action, '--diagnose');
});


test('an older allowlist response cannot revert newer list contents', async () => {
  const h = harness();
  const older = h.loadList('whitelist');
  const newer = h.loadList('whitelist');
  const first = h.pending.shift();
  const second = h.pending.shift();
  second.resolve({ errno: 0, stdout: 'new.example.com\n' });
  await newer;
  first.resolve({ errno: 0, stdout: 'old.example.com\n' });
  await older;
  assert.deepEqual(Array.from(h.state.lists.whitelist), ['new.example.com']);
});

test('failed status refresh must not present stale data as connected', async () => {
  const h = harness();
  const ok = h.refreshStatus(true);
  h.pending.shift().resolve(status('active'));
  await ok;
  const failed = h.refreshStatus(true, true);
  h.pending.shift().resolve({ errno: 1, stdout: '', stderr: 'backend offline' });
  await failed;
  assert.match(h.state.error, /backend offline/);
  assert.match(h.summaryText()[0], /暂不可用/);
});


test('late refresh for a previously selected profile must not erase current rows', async () => {
  const h = harness();
  h.state.profileEditor = 'balanced';
  const current = h.loadSources('balanced');
  h.pending.shift().resolve(sources('balanced-source'));
  await current;
  h.state.profileEditor = 'light';
  const light = h.loadSources('light');
  h.pending.shift().resolve(sources('light-source'));
  await light;
  const callsBefore = h.pending.length;
  await h.loadSources('balanced');
  assert.equal(h.pending.length, callsBefore);
  assert.equal(h.state.sources[0].url, 'light-source');
});


test('recently loaded rule source profile avoids another native call', async () => {
  const h = harness();
  const first = h.loadSources('balanced');
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve(sources('fresh-profile'));
  await first;
  const again = h.loadSources('balanced');
  await again;
  assert.equal(h.pending.length, 0);
  assert.equal(h.state.sources[0].url, 'fresh-profile');
});

test('mutating rule sources invalidates cached profile on next load', async () => {
  const h = harness();
  const first = h.loadSources('balanced');
  h.pending.shift().resolve(sources('before'));
  await first;
  vm.runInContext("sourceCache.delete('balanced'); sourceCacheTime.delete('balanced')", h.context);
  const changed = h.loadSources('balanced');
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve(sources('after'));
  await changed;
  assert.equal(h.state.sources[0].url, 'after');
});

test('expired rule source cache schedules a new Shell request', async () => {
  const h = harness();
  const first = h.loadSources('balanced');
  h.pending.shift().resolve(sources('before'));
  await first;
  vm.runInContext("sourceCacheTime.set('balanced', Date.now()-SOURCE_CACHE_MS-1)", h.context);
  const expired = h.loadSources('balanced');
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve(sources('after'));
  await expired;
  assert.equal(h.state.sources[0].url, 'after');
});


test('two concurrent reads of the same profile share one native Shell operation', async () => {
  const h = harness();
  const a = h.loadSources('balanced');
  const b = h.loadSources('balanced');
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve(sources('deduplicated'));
  await Promise.all([a, b]);
  assert.equal(h.state.sources[0].url, 'deduplicated');
});

test('recent personal lists are reused but a mutation forces a backend refresh', async () => {
  const h = harness();
  const first = h.loadList('blacklist');
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve({ errno: 0, stdout: 'first.example.com\n' });
  await first;
  await h.loadList('blacklist');
  assert.equal(h.pending.length, 0, 'cached list requires no native command');
  const forced = h.loadList('blacklist', true);
  assert.equal(h.pending.length, 1, 'explicit refresh bypasses cache');
  h.pending.shift().resolve({ errno: 0, stdout: 'changed.example.com\n' });
  await forced;
  assert.deepEqual(Array.from(h.state.lists.blacklist), ['changed.example.com']);
});


test('a mutation finishing on a hidden profile does not cancel the visible profile read', async () => {
  const h = harness();
  h.state.profileEditor = 'balanced';
  const visible = h.loadSources('balanced');
  vm.runInContext("invalidateSources('light')", h.context);
  h.pending.shift().resolve(sources('visible-balanced-source'));
  await visible;
  assert.equal(h.state.sources[0].url, 'visible-balanced-source');
  assert.equal(h.state.sourceError, '');
});

for (const [code, page] of [[0, 'logs'], [1, 'rules']]) {
  test('task completion ' + code + ' refreshes recent cached logs immediately on ' + page, async () => {
    const h = harness();
    h.state.page = page;
    vm.runInContext('let logPaints = 0; renderLogList = () => { logPaints++; };', h.context);
    const initial = h.loadLogs();
    h.pending.shift().resolve({ errno: 0, stdout: 'old activity' });
    await initial;
    vm.runInContext('logPaints = 0', h.context);
    await h.loadLogs();
    assert.equal(h.pending.length, 0, 'normal navigation still reuses the fresh cache');

    h.state.job = { id: '1001', action: '--update' };
    h.setBusy(true);
    const completed = h.monitorJob('1001', '--update');
    h.timers.shift()();
    await new Promise(setImmediate);
    const poll = h.pending.shift();
    assert.match(poll.command, /poll 1001$/);
    poll.resolve({ errno: 0, stdout: 'latest task output\nJOB_DONE=' + code });
    await new Promise(setImmediate);

    const logReads = h.pending.filter(x => x.command.endsWith(' recent'));
    assert.equal(logReads.length, 1, 'completion bypasses TTL using exactly one fresh log query');
    const shared = h.loadLogs(true);
    assert.equal(h.pending.filter(x => x.command.endsWith(' recent')).length, 1, 'concurrent refresh shares the in-flight query');
    logReads[0].resolve({ errno: 0, stdout: 'new completed task' });
    h.pending.find(x => x !== logReads[0]).resolve(status('active'));
    h.pending.length = 0;
    assert.equal(await completed, code);
    await shared;
    assert.deepEqual(Array.from(h.state.logs), ['new completed task']);
    assert.equal(h.state.job, null);
    assert.equal(h.state.busy, false);
    assert.equal(vm.runInContext('logPaints', h.context), page === 'logs' ? 1 : 0, 'paint only the visible log page once');
    await h.loadLogs();
    assert.equal(h.pending.length, 0, 'completed logs are reused without another Shell request');
  });
}

test('completion waits out a pre-completion log read then shares one fresh read without stale paint', async () => {
  const h = harness();
  h.state.page = 'logs';
  h.state.logsLoaded = true;
  h.state.logsLoadedAt = Date.now();
  h.state.logs = ['cached activity'];
  vm.runInContext('let logPaints = 0; renderLogList = () => { logPaints++; };', h.context);
  const older = h.loadLogs(true);
  const oldRead = h.pending.shift();
  const completed = h.monitorJob('1002', '--diagnose');
  h.timers.shift()();
  await new Promise(setImmediate);
  h.pending.shift().resolve({ errno: 0, stdout: 'diagnosis ready\nJOB_DONE=0' });
  await new Promise(setImmediate);
  const shared = h.loadLogs(true);
  oldRead.resolve({ errno: 0, stdout: 'snapshot from before completion' });
  await older;
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(h.state.logs), ['cached activity'], 'discard results taken before the completed task');
  assert.equal(vm.runInContext('logPaints', h.context), 0, 'do not paint the invalidated response');
  const fresh = h.pending.filter(x => x.command.endsWith(' recent'));
  assert.equal(fresh.length, 1, 'completion and concurrent refresh share one post-completion read');
  fresh[0].resolve({ errno: 0, stdout: 'new completed diagnosis' });
  h.pending.find(x => x !== fresh[0]).resolve(status('active'));
  h.pending.length = 0;
  assert.equal(await completed, 0);
  await shared;
  assert.deepEqual(Array.from(h.state.logs), ['new completed diagnosis']);
  assert.equal(vm.runInContext('logPaints', h.context), 1);
});
