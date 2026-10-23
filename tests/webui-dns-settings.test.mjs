import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, '').replace(/\ninit\(\);/, '\n');
const initial = () => ({ config: { upstream_dns: ['223.5.5.5','119.29.29.29'], bootstrap_dns: [], fallback_dns: ['114.114.114.114'], upstream_mode: 'parallel' }, revision: 'a'.repeat(64), editable: true, backup_available: true });
function harness() {
  const pending = [], handlers = {}, panel = { innerHTML: '' };
  const context = vm.createContext({ TextEncoder, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    document: { documentElement: {}, body: {}, addEventListener(n, fn) { handlers[n] = fn; }, querySelector(s) { return s === '#dns-settings-panel' ? panel : null; }, querySelectorAll() { return []; } },
    localStorage: {getItem(){return null;},setItem(){},removeItem(){}}, window: {},
    exec: command => new Promise(resolve => pending.push({ command, resolve })), setTimeout, clearTimeout, setInterval(){return 1;}, requestAnimationFrame(){}, cancelAnimationFrame(){} });
  vm.runInContext(source, context);
  const api = vm.runInContext('({state,loadDNS,fillDNSPreset,testDNS,saveDNS,dnsSettingsMarkup,dnsEditPayload,managePage})', context);
  return {context,pending,handlers,panel,...api};
}
async function load(h, info = initial()) {
  h.state.dnsOpen = true;
  const read = h.loadDNS(); h.pending.shift().resolve({errno:0,stdout:JSON.stringify(info)}); await read;
}
test('settings render without native calls and loaded settings preserve every managed value', async () => {
  const h = harness(); assert.match(h.managePage(), /data-action="dns-settings"/); assert.equal(h.pending.length, 0);
  await load(h); assert.deepEqual(JSON.parse(JSON.stringify(h.state.dnsDraft)), initial().config);
  assert.match(h.panel.innerHTML, /DNS 上游设置/); assert.match(h.panel.innerHTML, /当前查询模式及备用 DNS/);
  h.state.dnsDraft.upstream_dns = ['private.example']; assert.deepEqual(Array.from(h.state.dnsInfo.config.upstream_dns), initial().config.upstream_dns);
});
test('presets only edit the draft and keep current fallback and mode', async () => {
  const h = harness(); await load(h); h.fillDNSPreset('doh');
  assert.deepEqual(Array.from(h.state.dnsDraft.upstream_dns), ['https://dns.alidns.com/dns-query','https://doh.pub/dns-query']);
  assert.deepEqual(Array.from(h.state.dnsDraft.fallback_dns), ['114.114.114.114']); assert.equal(h.state.dnsDraft.upstream_mode, 'parallel');
  assert.deepEqual(Array.from(h.state.dnsInfo.config.upstream_dns), initial().config.upstream_dns); assert.equal(h.pending.length, 0);
});
test('testing sends only draft/revision and never starts a configuration write', async () => {
  const h = harness(); await load(h); h.fillDNSPreset('plain');
  const check = h.testDNS(); await h.testDNS(); assert.equal(h.pending.length, 1);
  const call = h.pending.shift(); assert.match(call.command, / dns-test /);
  const encoded = call.command.match(/'([^']+)'$/)[1], payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
  assert.equal(payload.revision, initial().revision); assert.deepEqual(payload.config, JSON.parse(JSON.stringify(h.state.dnsDraft)));
  call.resolve({errno:0,stdout:JSON.stringify([{server:'223.5.5.5',ok:true}])}); await check;
  assert.match(h.state.dnsMessage, /尚未更改/); assert.equal(h.state.dnsBusy, false); assert.equal(h.pending.length, 0);
});
test('failed or malformed tests do not show a passing result or retain previous results', async () => {
  const h = harness(); await load(h);
  for (const result of [{errno:1,stderr:'<offline>'},{errno:0,stdout:'[]'},{errno:0,stdout:'{"ok":true}'},{errno:0,stdout:'[{"server":"x","ok":"true"}]'}]) {
    h.state.dnsResults = [{server:'old',ok:true}]; const check = h.testDNS(); h.pending.shift().resolve(result); await check;
    assert.equal(h.state.dnsResults.length, 0); assert.ok(h.state.dnsError); assert.equal(h.state.dnsBusy, false);
    assert.doesNotMatch(h.panel.innerHTML, /<offline>/);
  }
});
test('saving requires confirmation then uses the background DNS job with an exact revision', async () => {
  const h = harness(); await load(h);
  vm.runInContext('confirm = (title,body,label,run) => { state.confirmRun = run; }; startJob = async (action,payload) => { state.started = {action,payload}; };',h.context);
  await h.saveDNS(); assert.equal(h.state.started, undefined); assert.equal(h.pending.length, 0);
  await h.state.confirmRun(); assert.equal(h.state.started.action, '--dns-save');
  const payload = JSON.parse(Buffer.from(h.state.started.payload,'base64').toString()); assert.equal(payload.revision, initial().revision);
});
test('restore uses only the loaded revision even when the unsaved draft is empty', async () => {
  const h = harness(); await load(h); h.state.dnsDraft.upstream_dns = [];
  vm.runInContext('confirm = (title,body,label,run) => { state.confirmRun = run; }; startJob = async (action,payload) => { state.started = {action,payload}; };',h.context);
  await h.saveDNS(true); await h.state.confirmRun(); assert.equal(h.state.started.action, '--dns-restore');
  assert.deepEqual(JSON.parse(Buffer.from(h.state.started.payload,'base64').toString()),{revision:initial().revision});
});
test('a failed refresh keeps the draft but discards stale write authority', async () => {
  const h = harness(); await load(h); h.state.dnsDraft.upstream_dns = ['1.1.1.1'];
  const refresh = h.loadDNS(); h.pending.shift().resolve({errno:1,stderr:'connection failed'}); await refresh;
  assert.equal(h.state.dnsInfo, null); assert.deepEqual(Array.from(h.state.dnsDraft.upstream_dns),['1.1.1.1']);
  assert.throws(()=>h.dnsEditPayload(), /请先读取/); assert.match(h.panel.innerHTML, /fieldset disabled/);
});
test('advanced configs are read-only and all dynamic fields are escaped', async () => {
  const h = harness(), info = initial(); info.editable = false; info.config.upstream_dns = ['</textarea><script>bad</script>'];
  await load(h,info); h.fillDNSPreset('doh');
  assert.deepEqual(Array.from(h.state.dnsDraft.upstream_dns),info.config.upstream_dns); assert.match(h.panel.innerHTML,/当前使用高级 DNS 配置/);
  assert.doesNotMatch(h.panel.innerHTML,/<script>/); assert.throws(()=>h.dnsEditPayload());
});
test('editing an address clears the obsolete test result without rewriting the form', async () => {
  const h = harness(); await load(h); h.state.dnsResults = [{server:'old',ok:true}]; const html=h.panel.innerHTML;
  h.handlers.input({target:{dataset:{dnsField:'upstream_dns'},value:'1.1.1.1\n8.8.8.8',matches:s=>s==='[data-dns-field]'}});
  assert.deepEqual(Array.from(h.state.dnsDraft.upstream_dns),['1.1.1.1','8.8.8.8']); assert.equal(h.state.dnsResults.length,0); assert.equal(h.panel.innerHTML,html);
});
