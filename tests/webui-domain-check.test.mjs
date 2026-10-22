import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '').replace(/\ninit\(\);/, '\n');
function harness() {
  const pending = [], handlers = {}, output = { innerHTML: '', setAttribute() {} }, button = { disabled: false };
  const context = vm.createContext({
    TextEncoder, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    document: { documentElement: {}, body: {}, addEventListener(n, fn) { handlers[n] = fn; }, querySelector(s) { return s === '#domain-result' ? output : s === '#domain-form button' ? button : null; }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, window: {},
    exec: command => new Promise(resolve => pending.push({ command, resolve })),
    setTimeout, clearTimeout, setInterval() { return 1; }, requestAnimationFrame() {}, cancelAnimationFrame() {}
  });
  vm.runInContext(source, context);
  return { context, pending, handlers, output, button, ...vm.runInContext('({state,parseDomainCheck,domainCheckMarkup,checkDomain,invalidateDomainCheck,rulesPage,setBusy,startJob})', context) };
}
const reasonTitles = {
  NotFilteredNotFound: '未命中过滤规则', NotFilteredWhiteList: '已命中放行规则', NotFilteredError: '规则检查异常',
  FilteredBlackList: '已命中拦截规则', FilteredSafeBrowsing: '安全浏览拦截', FilteredParental: '家长控制拦截',
  FilteredInvalid: '域名被判定为无效', FilteredSafeSearch: '安全搜索已改写', FilteredBlockedService: '服务策略拦截',
  Rewrite: 'DNS 重写', RewriteEtcHosts: 'Hosts 记录重写', RewriteRule: 'DNS 规则重写'
};
for (const [reason, title] of Object.entries(reasonTitles)) {
  test(`domain check explains ${reason} without relying on exit code or NXDOMAIN`, async () => {
    const h = harness(), query = h.checkDomain('Ads.Example.');
    assert.match(h.pending[0].command, /--check-domain 'ads.example'$/);
    assert.equal(h.button.disabled, true);
    assert.match(h.output.innerHTML, /正在查询/);
    h.pending.shift().resolve({ errno: 0, stdout: JSON.stringify({ reason }) });
    await query;
    assert.match(h.output.innerHTML, new RegExp(title));
    assert.equal(h.button.disabled, false);
    assert.equal(h.state.domainCheckInput, 'ads.example');
    assert.equal(h.output.innerHTML.includes('data-action="observe-allow"'), reason === 'FilteredBlackList');
  });
}

test('modern and legacy rule responses show exact escaped rule text and filter ID', () => {
  const h = harness();
  for (const data of [
    { reason: 'FilteredBlackList', rules: [{ filter_list_id: 123, text: '||ads.example^$important' }, { filter_list_id: '<img>', text: '<script>alert(1)</script>' }] },
    { reason: 'FilteredBlackList', filter_id: 123, rule: '||ads.example^$important' }
  ]) {
    h.state.domainCheck = { domain: 'ads.example', data };
    const html = h.domainCheckMarkup();
    assert.match(html, /\|\|ads\.example\^\$important/);
    assert.match(html, /过滤器 ID：123/);
    assert.doesNotMatch(html, /<script>|<img>/);
    assert.match(html, /应用完成后请重新检查/);
  }
});

test('rewrite targets and unknown statuses are escaped and never presented as ordinary allow results', () => {
  const h = harness();
  h.state.domainCheck = { domain: 'test.example', data: { reason: 'Rewrite', cname: '<img src=x>', ip_addrs: ['127.0.0.1', '<script>'] } };
  assert.match(h.domainCheckMarkup(), /重写目标：&lt;img src=x&gt;、127.0.0.1、&lt;script&gt;/);
  for (const reason of ['FutureReason', '__proto__', 'constructor', '<img src=x>']) {
    h.state.domainCheck.data = { reason };
    const html = h.domainCheckMarkup();
    assert.match(html, /未识别的检查状态/);
    assert.doesNotMatch(html, /未命中过滤规则|data-action="observe-allow"|<img/);
  }
});

test('malformed or empty success payloads do not turn into a no-match result', async () => {
  const h = harness();
  for (const stdout of ['', '<html>bad gateway</html>', '{}', '[]', 'null', '{"reason":null}', '{"reason":""}']) {
    const query = h.checkDomain('test.example');
    h.pending.shift().resolve({ errno: 0, stdout });
    await query;
    assert.match(h.output.innerHTML, /检查失败/);
    assert.doesNotMatch(h.output.innerHTML, /未命中过滤规则|data-action="observe-allow"/);
    assert.equal(h.button.disabled, false);
  }
});

test('invalid input is rejected locally before native execution', async () => {
  const h = harness();
  for (const input of ['', 'https://example.com/path', 'example.com;id', '<script>', 'localhost', 'a'.repeat(254) + '.com']) {
    await h.checkDomain(input);
    assert.match(h.output.innerHTML, /请输入完整域名/);
    assert.doesNotMatch(h.output.innerHTML, /<script>/);
  }
  assert.equal(h.pending.length, 0);
});

test('native failures replace old successful results and permit retry', async () => {
  const h = harness();
  h.state.domainCheck = { domain: 'old.example', data: { reason: 'NotFilteredNotFound' } };
  const query = h.checkDomain('test.example');
  h.pending.shift().resolve({ errno: 1, stderr: '<service unavailable>' });
  await query;
  assert.match(h.output.innerHTML, /检查失败：&lt;service unavailable&gt;/);
  assert.doesNotMatch(h.output.innerHTML, /未命中过滤规则/);
  assert.equal(h.button.disabled, false);
  const retry = h.checkDomain('test.example');
  h.pending.shift().resolve({ errno: 0, stdout: '{"reason":"NotFilteredWhiteList"}', stderr: 'diagnostic note' });
  await retry;
  assert.match(h.output.innerHTML, /已命中放行规则/);
});

test('duplicate submissions do not run extra checks and a rule change invalidates in-flight reads', async () => {
  const h = harness(), first = h.checkDomain('old.example');
  await h.checkDomain('ignored.example');
  assert.equal(h.pending.length, 1);
  h.invalidateDomainCheck();
  assert.match(h.output.innerHTML, /规则状态可能已变化/);
  const second = h.checkDomain('new.example');
  const oldRead = h.pending.shift(), newRead = h.pending.shift();
  newRead.resolve({ errno: 0, stdout: '{"reason":"NotFilteredWhiteList"}' });
  await second;
  oldRead.resolve({ errno: 0, stdout: '{"reason":"FilteredBlackList"}' });
  await first;
  assert.equal(h.state.domainCheck.domain, 'new.example');
  assert.match(h.output.innerHTML, /已命中放行规则/);
  assert.doesNotMatch(h.output.innerHTML, /加入个人放行名单/);
});

test('starting a rules-changing job marks a completed check stale and hides its allow action', async () => {
  const h = harness();
  vm.runInContext('monitorJob = async () => {};', h.context);
  for (const action of ['--apply-personal', '--update', '--sync-shared', '--rollback-history', '--filtering', '--factory-reset']) {
    h.state.job = null; h.state.busy = false;
    h.state.domainCheck = { domain: 'test.example', data: { reason: 'FilteredBlackList' } };
    const job = h.startJob(action);
    h.pending.shift().resolve({ errno: 0, stdout: 'started' });
    await job;
    assert.equal(h.state.domainCheck.stale, true);
    assert.match(h.output.innerHTML, /上次结果：已命中拦截规则/);
    assert.doesNotMatch(h.output.innerHTML, /data-action="observe-allow"/);
    assert.equal(h.button.disabled, true);
  }
});

test('unrelated diagnostic jobs preserve the rule snapshot and busy state prevents new checks', async () => {
  const h = harness();
  vm.runInContext('monitorJob = async () => {};', h.context);
  h.state.domainCheck = { domain: 'test.example', data: { reason: 'FilteredBlackList' } };
  const job = h.startJob('--diagnose');
  h.pending.shift().resolve({ errno: 0 }); await job;
  assert.notEqual(h.state.domainCheck.stale, true);
  assert.match(h.domainCheckMarkup(), /data-action="observe-allow"[^>]*disabled/);
  await h.checkDomain('other.example');
  assert.equal(h.pending.length, 0);
  h.setBusy(false);
  assert.equal(h.button.disabled, false);
});

test('the rules card preserves the domain input and result with an accessible label and status', () => {
  const h = harness();
  h.state.domainCheckInput = 'test.example';
  h.state.domainCheck = { domain: 'test.example', data: { reason: 'NotFilteredNotFound' } };
  const html = h.rulesPage();
  assert.match(html, /label class="field-label" for="check-domain"/);
  assert.match(html, /id="check-domain"[^>]*value="test.example"/);
  assert.match(html, /id="domain-result"[^>]*role="status"/);
  assert.match(html, /此检查不测试网络速度或网站可达性/);
  assert.match(html, /未命中过滤规则/);
});
