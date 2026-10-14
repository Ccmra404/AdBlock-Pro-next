import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../webroot/app.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/,'').replace(/\ninit\(\);[\s\S]*$/,'\n');
function harness() {
  const pending=[], handlers={}, storage=new Map();
  const context=vm.createContext({ TextEncoder, btoa: s=>Buffer.from(s).toString('base64'),
    document:{ documentElement:{},body:{},addEventListener(n,fn){handlers[n]=fn;},querySelector(){return null;},querySelectorAll(){return [];} },
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{},
    exec:command=>new Promise(resolve=>pending.push({command,resolve})),setTimeout,clearTimeout,requestAnimationFrame(){},cancelAnimationFrame(){} });
  vm.runInContext(source,context);
  return {context,pending,handlers,...vm.runInContext('({state,parsePersonalImport,loadList,loadSharedRules,resolveApplication,applicationResults,observationPanel,observationRows,personalRulesPage,logsPage,sharedResultsMarkup,startObservation})',context)};
}

test('TXT export sections, DNS rules and JSON import preserve blacklist and whitelist semantics',()=>{
  const h=harness();
  const txt=h.parsePersonalImport('# export\r\n[拦截名单]\r\nADS.Example\r\nads.example\n[放行名单]\nlogin.example\n@@||allow.example^\n||extra.example^');
  assert.deepEqual(JSON.parse(JSON.stringify(txt)),{blacklist:['ads.example','extra.example'],whitelist:['login.example','allow.example']});
  const json=h.parsePersonalImport(JSON.stringify({format:'adblock-pro-personal-rules',version:1,blacklist:['Ads.Example.'],whitelist:[]}));
  assert.deepEqual(Array.from(json.blacklist),['ads.example']);
});

test('invalid and excessive imports are rejected before executing any native command',()=>{
  const h=harness();
  for(const text of ['<script>alert(1)</script>','valid.example\nbad;command.example','[拦截名单]\n', '{"blacklist":[12]}', '{"version":0,"blacklist":["ads.example"]}', 'x'.repeat(65537)]) assert.throws(()=>h.parsePersonalImport(text));
  assert.equal(h.pending.length,0);
});

test('comment-only personal lists count as zero, with duplicates normalized',async()=>{
  const h=harness(); const read=h.loadList('blacklist');
  h.pending.shift().resolve({errno:0,stdout:'# historical seed\n\n ADS.Example \nads.example\n'});await read;
  assert.deepEqual(Array.from(h.state.lists.blacklist),['ads.example']);
});

test('shared reads share one command and a failed refresh retains the last valid snapshot',async()=>{
  const h=harness(), a=h.loadSharedRules(),b=h.loadSharedRules();assert.equal(h.pending.length,1);
  h.pending.shift().resolve({errno:0,stdout:'revision=2026101401\nupdated_at=123\ndomain\tads.example\ndomain\t<script>\n'});await Promise.all([a,b]);
  assert.deepEqual(Array.from(h.state.sharedRules),['ads.example']);
  const fail=h.loadSharedRules(true);h.pending.shift().resolve({errno:1,stderr:'offline'});await fail;
  assert.deepEqual(Array.from(h.state.sharedRules),['ads.example']);assert.equal(h.state.sharedError,'offline');
});

test('name/package matching requires an unambiguous application and escapes hostile labels',()=>{
  const h=harness();h.state.apps=[{packageName:'com.coolapk.market',label:'酷安'},{packageName:'app.other.market',label:'酷安测试 <img>'}];
  h.state.appQuery='酷';h.resolveApplication();assert.equal(h.state.selectedApp,null);
  h.state.appQuery='酷安';h.resolveApplication();assert.equal(h.state.selectedApp.packageName,'com.coolapk.market');
  assert.doesNotMatch(h.applicationResults(),/<img>/);assert.match(h.applicationResults(),/&lt;img&gt;/);
  h.state.appQuery='APP.OTHER.MARKET';h.resolveApplication();assert.equal(h.state.selectedApp.packageName,'app.other.market');
  assert.match(h.observationPanel(),/<option value="10" selected>/);assert.doesNotMatch(h.observationPanel(),/<option value="60"/);
});

test('shared domain lists paginate and search updates only the result container',()=>{
  const h=harness();h.state.sharedRules=Array.from({length:29},(_,i)=>`ads${i}.example`);h.state.sharedLoaded=true;
  assert.equal((h.sharedResultsMarkup().match(/class="rowitem"/g)||[]).length,10);
  h.state.sharedSearch='ads28'; assert.equal((h.sharedResultsMarkup().match(/class="rowitem"/g)||[]).length,1);
  assert.match(source, /matches\('#shared-search'\)[^\n]*renderSharedResults\(\)/);
  assert.doesNotMatch(source,/matches\('#shared-search'\)[^\n]*render\(true\)/);
});

test('observation failure shows its real cause rather than the generic worker-lock message',async()=>{
 const h=harness();
 vm.runInContext('refreshStatus=async()=>{}; loadLogs=async()=>{}; syncStatusView=()=>{}; render=()=>{};',h.context);
 h.context.document.querySelector=selector=>selector==='#toast'?{}:null;
 h.context.setTimeout=cb=>{cb();return 1;};
 const result=vm.runInContext("monitorJob('987','--observe')",h.context);
 await new Promise(setImmediate);
 h.pending.shift().resolve({errno:0,stdout:'[!] 查询日志正在写入磁盘。\n[!] Task failed or another DNS operation is already running (exit 1).\nJOB_DONE=1'});
 assert.equal(await result,1);assert.equal(h.state.observationError,'[!] 查询日志正在写入磁盘。');
});


test('domain observation leads personal lists and is absent from the operation log page',()=>{
 const h=harness(), lists=h.personalRulesPage();
 assert(lists.indexOf('>域名观察</h2>')<lists.indexOf('class="panel personal-summary"'));
 assert(lists.indexOf('class="panel personal-summary"')<lists.indexOf('data-action="shared-open"'));
 assert(lists.indexOf('data-list-results="whitelist"')<lists.indexOf('data-action="shared-open"'));
 assert.equal((lists.match(/id="observe-app"/g)||[]).length,1);
 h.state.logs=['1000\tsuccess\t--observe\t10\tObservation completed'];
 const logs=h.logsPage();assert.match(logs,/域名观察/);assert.match(logs,/Observation completed/);
 assert.doesNotMatch(logs,/id="observe-app"|id="observe-duration"|data-action="observe-start"/);
});

test('results start collapsed, preserve the user toggle across renders, and offer safe allow actions',async()=>{
 const h=harness();h.state.observation={id:'123',active:false,appLabel:'酷安'};
 h.state.observationDomains=[{domain:'ads.example',count:2,reason:'FilteredBlackList',filterId:123}];
 assert.match(h.observationPanel(),/<details id="observe-results" class="observe-results" >/);
 assert.doesNotMatch(h.observationPanel(),/<details[^>]*\sopen(?:\s|>)/);
 assert.match(h.observationPanel(),/data-action="observe-allow"/);assert.doesNotMatch(h.observationRows(),/data-action="observe-add"/);
 await h.handlers.toggle({target:{matches:s=>s==='#observe-results',open:true}});
 assert.match(h.personalRulesPage(),/<details id="observe-results" class="observe-results" open>/);
 assert.equal(h.pending.length,0,'opening results does not run another native command');
 h.state.lists.whitelist=['ads.example'];assert.doesNotMatch(h.observationRows(),/data-action="observe-allow"/);
});

test('allowing an observed domain confirms first, then saves the whitelist and refreshes its count',async()=>{
 const h=harness(),modal={},toast={};
 h.context.document.querySelector=s=>s==='#modal'?modal:s==='#toast'?toast:null;
 h.context.setTimeout=()=>1;
 vm.runInContext('render=()=>{}',h.context);
 const button={dataset:{action:'observe-allow',domain:'ads.example'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.equal(h.pending.length,0);assert.match(modal.innerHTML,/加入个人白名单/);
 const confirmed=modal.callback();assert.match(h.pending[0].command,/config add-whitelist 'ads.example'/);
 h.pending.shift().resolve({errno:0,stdout:'saved'});await new Promise(setImmediate);
 assert.match(h.pending[0].command,/config list-whitelist/);
 h.pending.shift().resolve({errno:0,stdout:'ads.example\n'});await confirmed;
 assert.deepEqual(Array.from(h.state.lists.whitelist),['ads.example']);assert.match(toast.textContent,/放行名单/);
});
