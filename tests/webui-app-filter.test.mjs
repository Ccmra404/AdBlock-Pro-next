import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/, '').replace(/\ninit\(\);[\s\S]*$/, '\n');
function harness() {
  const pending = [], catalogue = [], handlers = {}, panel = { innerHTML: '' }, results = { innerHTML: '' }, toast = {};
  const context = vm.createContext({
    document: { documentElement: {}, body: {}, addEventListener(name, fn) { handlers[name] = fn; },
      querySelector(selector) { return selector === '#app-filter-panel' ? panel : selector === '#app-filter-results' ? results : selector === '#toast' ? toast : null; }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, window: {},
    exec: command => new Promise(resolve => pending.push({ command, resolve })),
    listApplications: () => new Promise((resolve, reject) => catalogue.push({ resolve, reject })),
    setTimeout, clearTimeout, setInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
  });
  vm.runInContext(source, context);
  return { context, pending, catalogue, handlers, panel, results,
    ...vm.runInContext('({state, managePage, loadAppFilter, setAppFilter, resetAppFilter, monitorJob, appFilterEntries, appFilterMarkup, appFilterResultsMarkup, loadApplications})', context) };
}
async function load(h, text = '') {
  h.state.appFilterOpen = true;
  const request = h.loadAppFilter();
  assert.match(h.pending[0].command, / config app-filter-list$/);
  h.pending.shift().resolve({ errno: 0, stdout: text });
  await request;
}
const visible = { label: '音乐', packageName: 'com.example.music' };

test('settings add a lazy card and only opening it reads exclusions and apps', async () => {
  const h = harness();
  assert.match(h.managePage(), /应用过滤/); assert.equal(h.pending.length, 0); assert.equal(h.catalogue.length, 0);
  const opening = h.handlers.click({ target: { closest(selector) { return selector === '[data-action], [data-filter]' ? { dataset: { action: 'app-filter-open' } } : null; } } });
  assert.equal(h.catalogue.length, 1); assert.equal(h.pending.length, 1); assert.equal(h.state.appFilterOpen, true);
  h.catalogue.shift().resolve([visible]); h.pending.shift().resolve({ errno: 0, stdout: '' }); await opening;
  assert.match(h.panel.innerHTML, /参与过滤/); assert.equal(h.state.appFilterLoaded, true);
  assert.match(h.panel.innerHTML, /VPN 旁路/); assert.match(h.panel.innerHTML, /共享 UID/);
});

test('reading deduplicates exclusions and preserves unavailable and other user entries', async () => {
  const h = harness(); h.state.apps = [visible];
  await load(h, 'excluded\t0:com.example.music\nexcluded\t10:com.example.work\nexcluded\t0:com.example.gone\nexcluded\t0:com.example.gone\n');
  assert.equal(h.state.appFilterExcluded.length, 3); assert.equal(h.appFilterEntries().length, 3);
  assert.match(h.panel.innerHTML, /用户 10/); assert.match(h.panel.innerHTML, /当前应用列表不可见/);
  assert.equal((h.panel.innerHTML.match(/data-app-filter="0:com.example.music"/g) || []).length, 1);
});

test('search and paging only change visible rows, never saved exclusions', async () => {
  const h = harness(); h.state.apps = Array.from({ length: 23 }, (_, n) => ({ label: `应用 ${n}`, packageName: `com.example.app${n}` }));
  await load(h, 'excluded\t10:com.example.hidden\n');
  assert.equal((h.appFilterResultsMarkup().match(/data-app-filter=/g) || []).length, 10);
  h.state.appFilterPage = 2;
  h.handlers.input({ target: { value: '应用 22', matches: selector => selector === '#app-filter-search' } });
  assert.equal(h.state.appFilterPage, 0); assert.equal(h.appFilterEntries().length, 1);
  assert.deepEqual(Array.from(h.state.appFilterExcluded), ['10:com.example.hidden']); assert.equal(h.pending.length, 0);
});

test('a single toggle sends only that package and preserves hidden exclusions', async () => {
  const h = harness(); h.state.apps = [visible]; await load(h, 'excluded\t10:com.example.hidden\n');
  const write = h.setAppFilter('0:com.example.music', false);
  const call = h.pending.shift(); assert.match(call.command, / config app-filter-set '0:com.example.music' 'off' \d+$/);
  assert.equal(h.state.appFilterExcluded.includes('0:com.example.music'), false, 'do not change the switch before backend confirmation');
  await h.setAppFilter('0:com.example.music', false); assert.equal(h.pending.length, 0, 'duplicate writes are blocked');
  call.resolve({ errno: 0, stdout: '设置已保存；VPN 旁路中，恢复接管时生效。' }); await write;
  assert.deepEqual(Array.from(h.state.appFilterExcluded), ['10:com.example.hidden', '0:com.example.music']);
  assert.match(h.state.appFilterMessage, /VPN 旁路中/); assert.equal(h.state.busy, false);
});

test('unavailable exclusions can be removed even when the app catalogue fails', async () => {
  const h = harness(); await load(h, 'excluded\t10:com.example.gone\n'); h.state.appsError = 'Root 名称接口不可用';
  assert.match(h.appFilterMarkup(), /10:com.example.gone/);
  const write = h.setAppFilter('10:com.example.gone', true); h.pending.shift().resolve({ errno: 0, stdout: '' }); await write;
  assert.equal(h.state.appFilterExcluded.length, 0); assert.match(h.state.appFilterMessage, /已保存/);
});

test('failed writes preserve previous state, clear old success and require a fresh read', async () => {
  const h = harness(); h.state.apps = [visible]; await load(h);
  h.state.appFilterMessage = 'old success';
  const write = h.setAppFilter('0:com.example.music', false);
  h.pending.shift().resolve({ errno: 1, stdout: '<script>bad</script> firewall unavailable' }); await write;
  assert.equal(h.state.appFilterExcluded.length, 0); assert.equal(h.state.appFilterMessage, ''); assert.equal(h.state.appFilterLoaded, false);
  assert.match(h.panel.innerHTML, /请刷新确认/); assert.doesNotMatch(h.panel.innerHTML, /<script>/);
  assert.match(h.panel.innerHTML, /data-app-filter="0:com.example.music" checked disabled/);
  await h.setAppFilter('0:com.example.music', false); assert.equal(h.pending.length, 0);
  await load(h); assert.equal(h.state.appFilterLoaded, true); assert.equal(h.state.appFilterError, '');
});

test('read failures and malformed responses never appear to be an empty active exclusion list', async () => {
  const h = harness(); h.state.apps = [visible]; await load(h, 'excluded\t0:com.example.gone\n');
  for (const response of [{ errno: 1, stderr: 'root denied' }, ...['unexpected output', 'excluded\t0:com.example.music\textra', 'excluded\t0:bad;id', 'excluded\t00:com.example.music', 'excluded\t21474:com.example.music', `excluded\t0:com.example.${'a'.repeat(260)}`].map(stdout => ({ errno: 0, stdout }))]) {
    h.state.appFilterMessage = 'old success'; const request = h.loadAppFilter(); h.pending.shift().resolve(response); await request;
    assert.equal(h.state.appFilterLoaded, false); assert.equal(h.state.appFilterMessage, ''); assert.ok(h.state.appFilterError);
    assert.deepEqual(Array.from(h.state.appFilterExcluded), ['0:com.example.gone']); assert.match(h.panel.innerHTML, /刷新重试/);
  }
});

test('labels, search and backend messages are escaped, and invalid application ids cannot execute', async () => {
  const h = harness(); h.state.apps = [{ ...visible, label: '<img src=x onerror=bad>' }]; await load(h);
  h.state.appFilterQuery = '"><script>bad</script>'; h.state.appFilterMessage = '<iframe>';
  assert.doesNotMatch(h.appFilterMarkup(), /<script>|<iframe>|<img /);
  await h.setAppFilter('0:com.example.music;id', false); assert.equal(h.pending.length, 0);
});

test('global jobs disable application toggles and successful settings do not download subscriptions', async () => {
  const h = harness(); h.state.apps = [visible]; await load(h); h.state.busy = true;
  assert.match(h.appFilterMarkup(), /data-app-filter="0:com.example.music" checked disabled/);
  await h.setAppFilter('0:com.example.music', false); assert.equal(h.pending.length, 0);
  h.state.busy = false;
  const write = h.setAppFilter('0:com.example.music', false); h.pending.shift().resolve({ errno: 0, stdout: '已应用' }); await write;
  assert.equal(h.pending.length, 0); assert.match(h.appFilterMarkup(), /无需更新订阅/);
});

test('reset invalidates an in-flight read so its old selections cannot return', async () => {
  const h = harness(); h.state.appFilterOpen = true;
  const stale = h.loadAppFilter(); const oldCall = h.pending.shift();
  h.resetAppFilter(); const fresh = h.loadAppFilter(); const newCall = h.pending.shift();
  oldCall.resolve({ errno: 0, stdout: 'excluded\t0:com.example.old\n' }); await stale;
  assert.equal(h.state.appFilterLoading, true); assert.equal(h.state.appFilterExcluded.length, 0);
  newCall.resolve({ errno: 0, stdout: '' }); await fresh;
  assert.equal(h.state.appFilterLoaded, true); assert.equal(h.state.appFilterExcluded.length, 0);
});

for (const code of [0, 1]) test(`factory reset completion ${code} ${code === 0 ? 'clears and rereads' : 'preserves'} application exclusion state`, async () => {
  const h = harness();
  Object.assign(h.state, { busy: true, job: { id: '123', action: '--factory-reset' }, appFilterOpen: true, appFilterLoaded: true, appFilterExcluded: ['0:com.example.old'], appFilterMessage: 'old message', appFilterError: 'old error', appFilterQuery: 'old', appFilterPage: 2 });
  h.context.setTimeout = callback => setImmediate(callback);
  vm.runInContext('refreshStatus = async () => {}; loadLogs = async () => {}; loadSources = async () => {}; loadList = async () => {}; render = () => {}; syncStatusView = () => {};', h.context);
  const completion = h.monitorJob('123', '--factory-reset'); await new Promise(setImmediate);
  const poll = h.pending.shift(); assert.match(poll.command, / poll 123$/); poll.resolve({ errno: 0, stdout: `finished\nJOB_DONE=${code}` });
  await new Promise(setImmediate);
  if (code === 0) {
    assert.equal(h.state.appFilterExcluded.length, 0); assert.equal(h.state.appFilterLoaded, false); assert.equal(h.state.appFilterMessage, ''); assert.equal(h.state.appFilterError, ''); assert.equal(h.state.appFilterQuery, ''); assert.equal(h.state.appFilterPage, 0);
    const read = h.pending.shift(); assert.match(read.command, / config app-filter-list$/); read.resolve({ errno: 0, stdout: '' });
  }
  await completion;
  assert.equal(h.state.appFilterOpen, true);
  assert.deepEqual(Array.from(h.state.appFilterExcluded), code === 0 ? [] : ['0:com.example.old']);
  assert.equal(h.state.appFilterLoaded, true); assert.equal(h.pending.length, 0);
});
