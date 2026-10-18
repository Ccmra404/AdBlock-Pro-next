import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '').replace(/\ninit\(\);/, '\n');
function harness() {
  const pending = [], handlers = {}, storage = new Map(), nodes = new Map();
  nodes.set('#modal', {}); nodes.set('#toast', {});
  const context = vm.createContext({ TextEncoder, URL, btoa: s => Buffer.from(s).toString('base64'),
    document: { documentElement: {}, body: {}, addEventListener(n, fn) { handlers[n] = fn; }, querySelector(s) { return nodes.get(s) || null; }, querySelectorAll() { return []; } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }, window: {},
    exec: command => new Promise(resolve => pending.push({ command, resolve })), setTimeout, clearTimeout, setInterval() {}, requestAnimationFrame() {} });
  vm.runInContext(source, context);
  return { context, pending, handlers, storage, nodes, ...vm.runInContext('({state,applyPersonalRules,importPersonalLists,monitorJob,personalRulesPage,aiPanelMarkup,aiSettingsMarkup,managePage,observationSelectionTools,observationRows,startObservation,openAI,normalizeAIEndpoint,requestAIAnalysis,monitorAI,validateAIResult,selectedAIResults,importAIResults,communityIssueUrl,aiPayload,saveAIConfig})', context) };
}
const result = { domains: ['ads.example', 'login.example'], results: [{ domain: 'ads.example', verdict: 'ad', reason: '疑似广告' }, { domain: 'login.example', verdict: 'essential', reason: '登录服务' }] };
function ready(h) {
  Object.assign(h.state, { aiOpen: true, aiConfig: { configured: true, endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' }, observationDomains: [{ domain: 'ads.example' }], selectedObservationDomains: ['ads.example'] });
}
test('observation AI action opens consent directly, and rapid clicks share the status read', async () => {
  const h = harness(); ready(h); h.state.page = 'lists';
  const a = h.openAI(), b = h.openAI(); assert.equal(h.pending.length, 1);
  h.pending.shift().resolve({ errno: 0, stdout: JSON.stringify(h.state.aiConfig) });
  await Promise.all([a, b]);
  assert.match(h.nodes.get('#modal').innerHTML, /发送域名给 AI/);
  assert.equal(h.pending.length, 0); assert.equal(h.state.page, 'lists');
});
test('unconfigured analysis routes to settings without starting a request', async () => {
  const h = harness(); ready(h);
  vm.runInContext('navigate = page => { state.page = page; }; render = () => {};', h.context);
  let revealed = 0; h.nodes.set('#ai-settings-panel', { innerHTML: '', scrollIntoView() { revealed++; } });
  const opening = h.openAI(); h.pending.shift().resolve({ errno: 0, stdout: '{"configured":false}' }); await opening;
  assert.equal(h.state.page, 'manage'); assert.equal(h.state.aiSettingsOpen, true); assert.equal(revealed, 1);
  assert.match(h.nodes.get('#ai-settings-panel').innerHTML, /id="ai-config-form"/);
  assert.equal(h.pending.length, 0); assert.equal(h.nodes.get('#modal').innerHTML, undefined);
});
test('settings and result surfaces do not repeat configuration or the analysis button', () => {
  const h = harness(); ready(h); h.state.aiSettingsOpen = true; h.state.aiResults = result.results;
  h.state.lists.blacklist = ['ads.example'];
  assert.match(h.observationSelectionTools(), /AI 分析所选/);
  const results = h.aiPanelMarkup(); assert.match(results, /AI 分析结果/); assert.match(results, /已保存到个人名单/);
  assert.doesNotMatch(results, /ai-config-form|ai-analyze|接口地址|name="key"/);
  assert.match(h.aiSettingsMarkup(), /ai-config-form/);
  assert.match(h.managePage(), /id="ai-settings-panel"/);
});
test('AI settings summarize saved endpoint, model, and hidden key status', () => {
  const h = harness(); ready(h); h.state.aiSettingsOpen = true;
  const markup = h.aiSettingsMarkup();
  assert.match(markup, /当前配置已保存/);
  assert.match(markup, /https:\/\/api\.deepseek\.com\/chat\/completions/);
  assert.match(markup, /deepseek-flash/);
  assert.match(markup, /API 密钥：已保存（不回显）/);
  assert.match(markup, /留空保留原密钥/);
  assert.doesNotMatch(markup, /fixture-only-key/);
});
test('switching between raw and AI results reuses the result without extra requests', async () => {
  const h = harness(); ready(h); h.state.aiResults = result.results;
  const raw = { open: false, hidden: true, classList: { toggle(_, value) { raw.hidden = value; } } }; h.nodes.set('#observe-results', raw);
  const click = action => h.handlers.click({ target: { closest: selector => selector.includes('[data-action]') ? { dataset: { action } } : null } });
  await click('ai-back-observation'); assert.equal(h.state.aiOpen, false); assert.equal(raw.open, true); assert.equal(raw.hidden, false);
  await click('ai-view-results'); assert.equal(h.state.aiOpen, true); assert.equal(raw.hidden, true);
  assert.equal(h.pending.length, 0); assert.equal(h.state.aiResults.length, 2);
});
test('a new observation clears old AI suggestions and cannot overlap a running analysis', async () => {
  const h = harness(); ready(h); h.state.aiResults = result.results; h.state.aiBusy = true;
  await assert.rejects(h.startObservation(), /等待当前 AI/); assert.equal(h.state.aiResults.length, 2);
  h.state.aiBusy = false; h.state.status = { state: 'active' }; h.state.selectedApp = { label: '测试', packageName: 'app.example' };
  vm.runInContext('startJob = async () => {};', h.context);
  await h.startObservation(); assert.equal(h.state.aiResults.length, 0); assert.equal(h.state.aiOpen, false);
  assert.equal(h.pending.length, 0);
});
test('base URLs are normalized without accepting HTTP, credentials or query parameters', () => {
  const h = harness();
  assert.equal(h.normalizeAIEndpoint('https://gateway.example/v1/'), 'https://gateway.example/v1/chat/completions');
  assert.equal(h.normalizeAIEndpoint('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com/chat/completions');
  for (const url of ['http://gateway.example', 'https://u:p@gateway.example', 'https://gateway.example?key=x', 'https://gateway.example/#x']) assert.throws(() => h.normalizeAIEndpoint(url));
});
test('external analysis waits for explicit consent and sends only the selected domain snapshot', async () => {
  const h = harness(); ready(h); h.requestAIAnalysis();
  assert.equal(h.pending.length, 0); assert.match(h.nodes.get('#modal').innerHTML, /api.deepseek.com/);
  h.state.selectedObservationDomains = [];
  const submitted = h.nodes.get('#modal').callback();
  const start = h.pending.shift(); assert.match(start.command, /ai-start/);
  const payload = JSON.parse(Buffer.from(start.command.match(/'([A-Za-z0-9+/=]+)'$/)[1], 'base64').toString());
  assert.deepEqual(payload, { domains: ['ads.example'], endpoint: h.state.aiConfig.endpoint, model: 'deepseek-flash' });
  start.resolve({ errno: 0, stdout: '{"status":"queued"}' }); await submitted;
  h.pending.shift().resolve({ errno: 0, stdout: JSON.stringify({ status: 'success', ...result }) });
  await new Promise(setImmediate);
  assert.equal(h.state.aiResults.length, 2); assert.equal(h.state.aiSelected.length, 0);
  assert.equal(h.state.busy, false); assert.equal(h.storage.size, 0);
  assert.deepEqual(Array.from(h.state.lists.blacklist), []);
});
test('invalid and invented AI results fail without applying any rules', async () => {
  const h = harness();
  for (const j of [{ ...result, results: [result.results[0]] }, { ...result, results: [result.results[0], result.results[0]] }, { ...result, results: [{ domain: 'evil.example', verdict: 'ad', reason: 'x' }, result.results[1]] }, { domains: ['127.0.0.1'], results: [] }]) assert.throws(() => h.validateAIResult(j));
  const monitor = h.monitorAI('123');
  h.pending.shift().resolve({ errno: 0, stdout: JSON.stringify({ status: 'success', domains: ['ads.example'], results: [{ domain: 'foreign.example', verdict: 'ad', reason: 'bad' }] }) });
  await monitor; assert.match(h.state.aiError, /不匹配/); assert.equal(h.state.aiBusy, false);
  assert.equal(h.pending.length, 0); assert.deepEqual(Array.from(h.state.lists.blacklist), []);
});
test('API failures release only the AI UI state and do not touch a running DNS operation', async () => {
  const h = harness(); h.state.busy = true; h.storage.set('abp-ai-job', '123');
  const monitor = h.monitorAI('123');
  h.pending.shift().resolve({ errno: 1, stderr: '认证失败' }); await monitor;
  assert.match(h.state.aiError, /认证失败/); assert.equal(h.state.busy, true); assert.equal(h.state.aiBusy, false); assert.equal(h.storage.size, 0);
});
test('result HTML escapes model text, paginates, and excludes normal services from selection', () => {
  const h = harness(); ready(h);
  h.state.aiResults = Array.from({ length: 21 }, (_, i) => ({ domain: `ads${i}.example`, verdict: 'ad', reason: '<img src=x onerror=alert(1)>' }));
  h.state.aiResults[0].verdict = 'essential'; h.state.aiSelected = ['ads0.example', 'ads1.example', 'evil.example'];
  assert.deepEqual(Array.from(h.selectedAIResults()), ['ads1.example']);
  const html = h.aiPanelMarkup(); assert.equal((html.match(/data-ai-domain=/g) || []).length, 10);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); assert.match(html, /第 1 \/ 3 页/);
  assert.match(html, /data-ai-domain="ads0.example"[^>]*disabled/);
  const draft = new URL(h.communityIssueUrl(h.selectedAIResults()));
  assert.match(draft.searchParams.get('body'), /ads1.example/); assert.doesNotMatch(draft.searchParams.get('body'), /ads0.example|evil.example/);
});
test('personal import refreshes existing lists and previews only nonoverlapping AI suggestions', async () => {
  const h = harness(); ready(h); h.state.aiResults = result.results; h.state.aiSelected = ['ads.example', 'login.example'];
  const prepare = h.importAIResults(); assert.equal(h.pending.length, 2);
  h.pending.shift().resolve({ errno: 0, stdout: 'login.example\n' }); h.pending.shift().resolve({ errno: 0, stdout: 'existing.example\n' }); await prepare;
  assert.equal(h.pending.length, 0); assert.match(h.nodes.get('#modal').innerHTML, /合并导入 1 个/);
  assert.deepEqual(Array.from(h.state.lists.whitelist), ['login.example']);
  assert.deepEqual(Array.from(h.state.lists.blacklist), ['existing.example']);
});
test('keys are transported separately from logs and never persisted in browser storage or markup', async () => {
  const h = harness(); ready(h);
  h.context.FormData = class { get(k) { return { endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', key: 'fixture-only-key' }[k]; } };
  const input = { value: 'fixture-only-key' };
  const saving = h.saveAIConfig({ querySelector: () => input });
  const command = h.pending.shift(); assert.match(command.command, /ai-config/); assert.doesNotMatch(command.command, / config |fixture-only-key/);
  command.resolve({ errno: 0, stdout: JSON.stringify(h.state.aiConfig) }); await saving;
  assert.equal(input.value, ''); assert.equal(h.storage.size, 0); assert.doesNotMatch(h.aiPanelMarkup(), /fixture-only-key/);
});

test('both result surfaces select across pages and clear all without sending requests', async () => {
  const h = harness(); ready(h);
  h.state.observationDomains = Array.from({ length: 25 }, (_, i) => ({ domain: `domain${i}.example` }));
  h.state.observationPage = 2;
  h.state.aiResults = h.state.observationDomains.map((r, i) => ({ ...r, verdict: i === 1 ? 'essential' : 'ad', reason: '' }));
  h.state.aiPage = 2;
  const click = action => h.handlers.click({ target: { closest: s => s.includes('[data-action]') ? { dataset: { action } } : null } });
  await click('observe-select-all'); assert.equal(h.state.selectedObservationDomains.length, 25);
  assert.match(h.observationSelectionTools(), /25 个已选/);
  await click('observe-clear-selection'); assert.equal(h.state.selectedObservationDomains.length, 0);
  await click('ai-select-all'); assert.equal(h.selectedAIResults().length, 24);
  assert.ok(!h.selectedAIResults().includes('domain1.example'));
  assert.match(h.aiPanelMarkup(), /24 个已选/);
  await click('ai-clear-selection'); assert.equal(h.selectedAIResults().length, 0);
  assert.equal(h.pending.length, 0);
});

test('observation displays and selects every captured domain while AI stays limited to 50', async () => {
  const h = harness(); h.state.observationDomains = Array.from({ length: 70 }, (_, i) => ({ domain: `domain${i}.example` }));
  await h.handlers.click({ target: { closest: s => s.includes('[data-action]') ? { dataset: { action: 'observe-select-all' } } : null } });
  assert.equal(h.state.selectedObservationDomains.length, 70);
  assert.ok(h.state.selectedObservationDomains.includes('domain69.example'));
  assert.match(h.observationSelectionTools(), /AI 一次最多 50 个/);
  assert.match(h.observationSelectionTools(), /data-action="ai-open" disabled/);
  h.state.observationPage = 6;
  assert.match(h.observationRows(), /domain69\.example/);
  assert.match(h.observationRows(), /第 7 \/ 7 页/);
});

test('failed personal apply startup keeps saved rules and offers retry without a global update', async () => {
  const h = harness(); h.state.page = 'lists';
  vm.runInContext('render=()=>{}', h.context);
  h.state.lists.blacklist = ['saved.example'];
  const applying = h.applyPersonalRules();
  assert.match(h.pending[0].command, /start \d+ --apply-personal$/);
  h.pending.shift().resolve({ errno: 1, stderr: 'worker unavailable' });
  await assert.rejects(applying, /名单已保存.*尚未应用/);
  assert.equal(h.state.personalApplyError, true); assert.equal(h.state.busy, false);
  assert.deepEqual(Array.from(h.state.lists.blacklist), ['saved.example']);
  assert.match(h.personalRulesPage(), /应用个人名单.*重试/);
  assert.equal(h.pending.length, 0);
});

for (const code of [0, 1]) test(`personal apply completion (${code}) reports actual application status and preserves paused filtering`, async () => {
  const h = harness(); h.state.page = 'lists'; h.state.status = { filtering_enabled: 'false' };
  h.context.setTimeout = cb => { cb(); return 1; };
  vm.runInContext('refreshStatus=async()=>{}; loadLogs=async()=>{}; syncStatusView=()=>{}; render=()=>{};', h.context);
  const monitoring = h.monitorJob('123', '--apply-personal'); await new Promise(setImmediate);
  assert.match(h.pending[0].command, /poll 123$/);
  h.pending.shift().resolve({ errno: 0, stdout: `local apply\nJOB_DONE=${code}` });
  assert.equal(await monitoring, code);
  assert.equal(h.state.personalApplyError, code !== 0); assert.equal(h.state.status.filtering_enabled, 'false');
  assert.match(h.state.personalApplyMessage, code ? /名单已保存.*应用失败.*重试/ : /名单已应用.*过滤当前关闭/);
  assert.equal(h.state.busy, false); assert.equal(h.pending.length, 0);
});
