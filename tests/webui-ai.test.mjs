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
  return { context, pending, handlers, storage, nodes, ...vm.runInContext('({state,aiPanelMarkup,normalizeAIEndpoint,requestAIAnalysis,monitorAI,validateAIResult,selectedAIResults,importAIResults,communityIssueUrl,aiPayload,saveAIConfig})', context) };
}
const result = { domains: ['ads.example', 'login.example'], results: [{ domain: 'ads.example', verdict: 'ad', reason: '疑似广告' }, { domain: 'login.example', verdict: 'essential', reason: '登录服务' }] };
function ready(h) {
  Object.assign(h.state, { aiOpen: true, aiConfig: { configured: true, endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' }, observationDomains: [{ domain: 'ads.example' }], selectedObservationDomains: ['ads.example'] });
}
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
