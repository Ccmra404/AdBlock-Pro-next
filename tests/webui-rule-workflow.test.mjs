import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../webroot/app.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/,'').replace(/\ninit\(\);/,'\n');
function harness() {
  const pending=[], handlers={}, storage=new Map();
  const context=vm.createContext({ TextEncoder, btoa: s=>Buffer.from(s,'binary').toString('base64'),
    document:{ documentElement:{},body:{},addEventListener(n,fn){handlers[n]=fn;},querySelector(){return null;},querySelectorAll(){return [];} },
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{},
    exec:command=>new Promise(resolve=>pending.push({command,resolve})),setTimeout,clearTimeout,setInterval(){return 1;},requestAnimationFrame(){},cancelAnimationFrame(){} });
  vm.runInContext(source,context);
  return {context,pending,handlers,...vm.runInContext('({state,parsePersonalImport,preparePersonalImport,importPersonalFile,loadList,loadSharedRules,loadApplications,resolveApplication,applicationResults,observationPanel,observationRows,observationSelectionTools,selectedObservationDomains,observationExportText,exportObservedDomains,saveExportFile,observationAIPrompt,communityIssueUrl,parseObservationSnapshot,loadObservationResult,startJob,personalRulesPage,sharedRulesPage,logsPage,rulesPage,sourceRows,externalSubscriptionsMarkup,sharedResultsMarkup,startObservation,savePersonalDomain})',context)};
}

test('the optional paired source explains its scope and uses the module directory controls', () => {
  const h = harness();
  h.state.sources = [{id:'goodbyeads', label:'GOODBYEADS DNS（含配套放行）', url:'https://filters.example/dns.txt', enabled:'disabled'}];
  const markup = h.sourceRows();
  assert.match(markup, /拦截与放行成对更新/);
  assert.match(markup, /与秋风部分重复，按需选择/);
  assert.match(markup, /data-action="source-toggle"[^>]*>加入目录/);
  assert.match(markup, /data-action="source-delete"/);
  assert.match(markup, /目录外/);
});

test('a manual allow action refreshes both lists before applying the moved rule', async () => {
  const h = harness();
  h.state.lists.blacklist = ['ads.example']; h.state.lists.whitelist = [];
  vm.runInContext('render = () => {}; startJob = async action => { state.testApply = action; };', h.context);
  const saved = h.savePersonalDomain('add-whitelist', 'ads.example', 'whitelist');
  assert.match(h.pending[0].command, /config add-whitelist/);
  h.pending.shift().resolve({errno:0, stdout:'saved'});
  await new Promise(setImmediate);
  const reads = h.pending.splice(0);
  assert.equal(reads.length, 2);
  assert.ok(reads.some(x => x.command.includes('list-blacklist')));
  assert.ok(reads.some(x => x.command.includes('list-whitelist')));
  for (const read of reads) read.resolve({errno:0, stdout:read.command.includes('list-whitelist') ? 'ads.example\n' : ''});
  await saved;
  assert.deepEqual(Array.from(h.state.lists.blacklist), []);
  assert.deepEqual(Array.from(h.state.lists.whitelist), ['ads.example']);
  assert.equal(h.state.testApply, '--apply-personal');
});

test('TXT export sections, DNS rules and JSON import preserve blacklist and whitelist semantics',()=>{
  const h=harness();
  const txt=h.parsePersonalImport('# export\r\n[拦截名单]\r\nADS.Example\r\nads.example\n[放行名单]\nlogin.example\n@@||allow.example^\n||extra.example^');
  assert.deepEqual(JSON.parse(JSON.stringify(txt)),{blacklist:['ads.example','extra.example'],whitelist:['login.example','allow.example']});
  const json=h.parsePersonalImport(JSON.stringify({format:'adblock-pro-personal-rules',version:1,blacklist:['Ads.Example.'],whitelist:[]}));
  assert.deepEqual(Array.from(json.blacklist),['ads.example']);
});

test('import preview detects both directions of a domain overlap without changing the incoming batch', () => {
  const h = harness();
  h.state.lists.blacklist = ['ads.example', 'deep.track.example'];
  h.state.lists.whitelist = ['pay.example'];
  const incoming = h.parsePersonalImport(JSON.stringify({
    blacklist: ['ADS.Example.', 'sub.ads.example', 'track.example', 'notads.example', 'fresh.example', 'child.fresh.example'],
    whitelist: ['pay.example', 'sub.pay.example', 'new.example'],
  }));
  const preview = JSON.parse(JSON.stringify(h.preparePersonalImport(incoming)));
  assert.deepEqual(preview, {
    lists: { blacklist: ['notads.example', 'fresh.example', 'child.fresh.example'], whitelist: ['new.example'] },
    skipped: 5,
  });
});

test('import preview agrees with the original overlap rules for varied domains', () => {
  const h = harness();
  let seed = 12345;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const domain = () => Array.from({ length: 2 + random(3) }, () => ['a', 'aa', 'b', 'shop', 'ads'][random(5)]).join('.');
  const touches = (candidate, list) => list.some(item => candidate === item || candidate.endsWith('.' + item) || item.endsWith('.' + candidate));
  for (let round = 0; round < 40; round++) {
    const old = { blacklist: Array.from({length: 40}, domain), whitelist: Array.from({length: 40}, domain) };
    const incoming = { blacklist: Array.from({length: 25}, domain), whitelist: Array.from({length: 25}, domain) };
    h.state.lists = old;
    const expected = { lists: { blacklist: [], whitelist: [] }, skipped: 0 };
    for (const kind of ['blacklist', 'whitelist']) for (const item of incoming[kind]) {
      if (touches(item, old.blacklist) || touches(item, old.whitelist)) expected.skipped++;
      else expected.lists[kind].push(item);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(h.preparePersonalImport(incoming))), expected);
  }
});

test('import preview preserves overlap matching for malformed and unusually long saved lines', () => {
  const h = harness();
  const old = {
    blacklist: ['a..ads.example', '.odd.example', 'broken.example.', 'single', 'x.'.repeat(10000) + 'deep.example'],
    whitelist: ['pay.example'],
  };
  const incoming = { blacklist: ['ads.example', 'odd.example', 'broken.example', 'deep.example', 'normal.example'], whitelist: ['sub.pay.example'] };
  h.state.lists = old;
  const touches = (candidate, list) => list.some(item => candidate === item || candidate.endsWith('.' + item) || item.endsWith('.' + candidate));
  const expected = { lists: { blacklist: [], whitelist: [] }, skipped: 0 };
  for (const kind of ['blacklist', 'whitelist']) for (const item of incoming[kind]) {
    if (touches(item, old.blacklist) || touches(item, old.whitelist)) expected.skipped++;
    else expected.lists[kind].push(item);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.preparePersonalImport(incoming))), expected);
});

test('invalid and excessive imports are rejected before executing any native command',()=>{
  const h=harness();
  for(const text of ['<script>alert(1)</script>','valid.example\nbad;command.example','[拦截名单]\n', '{"blacklist":[12]}', '{"version":0,"blacklist":["ads.example"]}', '[拦截名单]\nshared.example\n[放行名单]\nshared.example', 'x'.repeat(65537)]) assert.throws(()=>h.parsePersonalImport(text));
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

test('manual application refresh finds an app installed after the catalogue was cached',async()=>{
 const h=harness();let calls=0;
 h.context.listApplications=async()=>{calls++;return calls===1?[{packageName:'com.coolapk.market',label:'酷安'}]:[{packageName:'com.coolapk.market',label:'酷安'},{packageName:'com.tencent.qqmusic',label:'QQ音乐'}];};
 await h.loadApplications();await h.loadApplications();assert.equal(calls,1);
 h.state.appQuery='QQ音乐';h.resolveApplication();assert.equal(h.state.selectedApp,null);
 assert.match(h.observationPanel(),/data-action="apps-refresh"/);
 const button={dataset:{action:'apps-refresh'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});await new Promise(setImmediate);
 assert.equal(calls,2);assert.equal(h.state.selectedApp.packageName,'com.tencent.qqmusic');
});

test('concurrent application refreshes share one host request and failed reads retain the valid catalogue',async()=>{
 const h=harness();let calls=0,resolveRead;
 h.context.listApplications=()=>{calls++;return new Promise(resolve=>{resolveRead=resolve;});};
 const a=h.loadApplications(true),b=h.loadApplications(true);assert.equal(calls,1);
 resolveRead([{packageName:'com.tencent.qqmusic',label:'QQ音乐'}]);await Promise.all([a,b]);
 h.context.listApplications=async()=>{throw new Error('host unavailable');};await h.loadApplications(true);
 assert.equal(h.state.apps[0].packageName,'com.tencent.qqmusic');assert.equal(h.state.appsError,'host unavailable');assert.equal(h.state.appsLoading,false);
});

test('returning to the visible observation page refreshes cached apps without polling other pages or active jobs',async()=>{
 const h=harness();let calls=0;
 vm.runInContext('refreshStatus=async()=>{}',h.context);
 h.state.page='lists';h.state.appsLoaded=true;h.state.appQuery='QQ音乐';
 h.context.listApplications=async()=>{calls++;return [{packageName:'com.tencent.qqmusic',label:'QQ音乐'}];};
 h.context.document.hidden=false;h.handlers.visibilitychange();await new Promise(setImmediate);
 assert.equal(calls,1);assert.equal(h.state.selectedApp.packageName,'com.tencent.qqmusic');
 for(const scenario of [{hidden:true,page:'lists',busy:false},{hidden:false,page:'home',busy:false},{hidden:false,page:'lists',busy:true}]) {
   Object.assign(h.state,{page:scenario.page,busy:scenario.busy});h.context.document.hidden=scenario.hidden;
   h.handlers.visibilitychange();await new Promise(setImmediate);
 }
 assert.equal(calls,1);assert.equal(h.pending.length,0);
});

test('shared domain lists paginate and search updates only the result container',()=>{
  const h=harness();h.state.sharedRules=Array.from({length:29},(_,i)=>`ads${i}.example`);h.state.sharedLoaded=true;
  assert.equal((h.sharedResultsMarkup().match(/class="rowitem"/g)||[]).length,10);
  h.state.sharedSearch='ads28'; assert.equal((h.sharedResultsMarkup().match(/class="rowitem"/g)||[]).length,1);
  assert.match(source, /matches\('#shared-search'\)[^\n]*renderSharedResults\(\)/);
  assert.doesNotMatch(source,/matches\('#shared-search'\)[^\n]*render\(true\)/);
});

test('shared rules page offers candidate submission instead of exporting the shared list',()=>{
 const h=harness();h.state.sharedRules=['published.example'];
 const page=h.sharedRulesPage();
 assert.match(page,/data-action="shared-submit-candidate"/);
 assert.match(page,/data-action="shared-source-add">加入规则来源/);
 assert.doesNotMatch(page,/data-action="shared-export"|导出规则/);
 assert.match(page,/手动提交/);assert.match(page,/维护者审核通过后才会进入共享规则/);
});

test('restoring the shared source saves it and immediately refreshes the source list',async()=>{
 const h=harness(),toast={textContent:'',hidden:true};
 h.context.document.querySelector=s=>s==='#toast'?toast:null;h.context.setTimeout=()=>1;
 const button={dataset:{action:'shared-source-add'}};
 const click=h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.match(h.pending[0].command,/config set-source 'shared' 'on' 'balanced'/);
 h.pending.shift().resolve({errno:0,stdout:'[+] 共享抓包规则 source state saved'});
 await new Promise(setImmediate);
 assert.match(h.pending[0].command,/config list-sources/);
 h.pending.shift().resolve({errno:0,stdout:'mode\tbalanced\nsource\tshared\t共享抓包规则\tshared\tenabled\tconfigured\tremovable\n'});
 await click;
 assert.equal(h.state.sources[0].url,'shared');
 assert.match(toast.textContent,/共享规则来源已加入/);
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

test('rule source page has no tiers and makes every bundled or custom source manageable',()=>{
 const h=harness();h.state.sources=[
  {id:'10007',label:'10007',url:'https://rules.example/base.txt',enabled:'enabled',removable:'removable'},
  {id:'shared',label:'共享抓包规则',url:'shared',enabled:'disabled',removable:'removable'},
  {id:'custom',label:'我的订阅',url:'https://rules.example/custom.txt',enabled:'disabled',removable:'removable'}
 ];
 const page=h.rulesPage();
 assert.doesNotMatch(page,/轻量|均衡|严格|档位/);
 assert.match(page,/10007/);assert.match(page,/data-action="source-toggle"[^>]*>移出目录/);
 assert.match(page,/data-action="source-toggle"[^>]*>加入目录/);
 assert.match(page,/data-action="source-delete"/);assert.match(page,/data-action="source-rename-open"/);
 assert.match(page,/data-action="source-url-open"/);
 assert.match(page,/name="name" maxlength="64"/);assert.match(page,/name="url"/);
});

test('rule page shows module and native AdGuard Home subscriptions in one actionable list',()=>{
 const h=harness();
 h.state.sources=[{id:'custom',label:'Module source',url:'https://module.example/list.txt',enabled:'enabled'}];
 const local='/data/adb/adblockpro/bin/userfilters/adblock-pro-source-abc.txt';
 h.state.status={module_source_map:`https://module.example/list.txt\t${local}|https://legacy-module.example/list.txt\t/data/adb/adblockpro/bin/userfilters/adblock-pro-source-old.txt`,dns_filter_json:{filters:[
  {name:'Manual subscription <test>',url:'https://manual.example/list.txt?token=fixture',enabled:true,rules_count:42},
  {name:'Legacy module subscription',url:'/data/adb/adblockpro/bin/userfilters/adblock-pro-source-old.txt',enabled:false,rules_count:10},
  {name:'Module source',url:local,enabled:true,rules_count:20},
  {name:'Personal rules',url:'/data/adb/adblockpro/bin/userfilters/adblock-pro-user-rules.txt',enabled:true,rules_count:4},
 ],whitelist_filters:[{name:'Manual allow list',url:'https://allow.example/list.txt',enabled:true,rules_count:3}]}};
 const external=h.externalSubscriptionsMarkup();
 assert.match(external,/当前订阅/);
 assert.match(external,/manual\.example\/list\.txt\?token=fixture/);
 assert.match(external,/Manual subscription &lt;test&gt;/);
 assert.match(external,/42 条/);
 assert.match(external,/来源：https:\/\/module\.example\/list\.txt/);
 assert.match(external,/allow\.example\/list\.txt/);
 assert.match(external,/已停用/);
 assert.doesNotMatch(external,/adblock-pro-user-rules|adblock-pro-shared-app-rules/);
 assert.doesNotMatch(external,/<small>[^<]*adblock-pro-source-/,'module cache paths are not shown as the subscription address');
 assert.match(external,/data-action="subscription-toggle"/);
 assert.match(external,/data-action="subscription-rename-open"/);
 assert.match(external,/data-action="subscription-remove"/);
 assert.match(h.rulesPage(),/id="external-subscriptions"/);
});

test('native subscription panel distinguishes unavailable status from an empty list',()=>{
 const h=harness();
 assert.match(h.externalSubscriptionsMarkup(),/尚未读取 AdGuard Home 订阅/);
 h.state.status={dns_health:'api_failed',dns_filter_json:{}};
 assert.match(h.externalSubscriptionsMarkup(),/暂时无法读取/);
 h.state.status={dns_filter_json:{filters:[],whitelist_filters:[]}};
 assert.match(h.externalSubscriptionsMarkup(),/AdGuard Home 当前没有普通订阅/);
 h.state.status={dns_filter_json:{filters:null,whitelist_filters:null}};
 assert.match(h.externalSubscriptionsMarkup(),/AdGuard Home 当前没有普通订阅/);
});

test('removing a module directory entry leaves current AdGuard Home subscriptions untouched',async()=>{
 const h=harness(),modal={},toast={textContent:'',hidden:true};
 h.state.sources=[{id:'shared',label:'共享抓包规则',url:'shared',enabled:'enabled',removable:'removable'}];
 h.context.document.querySelector=s=>s==='#modal'?modal:s==='#toast'?toast:null;h.context.setTimeout=()=>1;
 const button={dataset:{action:'source-delete',url:'shared'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.match(modal.innerHTML,/不会删除或停用 AdGuard Home 当前订阅/);
 const remove=modal.callback();
 assert.match(h.pending[0].command,/config remove-source 'shared'/);
 h.pending.shift().resolve({errno:0,stdout:'removed'});
 await new Promise(setImmediate);
 assert.match(h.pending[0].command,/config list-sources/);
 h.pending.shift().resolve({errno:0,stdout:'mode\tbalanced\n'});
 await remove;
 assert.deepEqual(Array.from(h.state.sources),[]);
 assert.match(toast.textContent,/当前订阅状态未更改/);
});

test('operation log page can copy recent detailed task output',async()=>{
 const h=harness(),toast={};let copied='';
 h.context.document.querySelector=s=>s==='#toast'?toast:null;
 h.context.navigator={clipboard:{writeText:async text=>{copied=text;}}};h.context.setTimeout=()=>1;
 assert.match(h.logsPage(),/data-action="logs-copy">复制日志/);
 const button={dataset:{action:'logs-copy'}};
 const click=h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.equal(h.pending.length,1);assert.match(h.pending[0].command,/recent-full$/);
 h.pending[0].resolve({errno:0,stdout:'===== 最新任务 =====\nsubscription timed out'});
 await click;
 assert.match(copied,/subscription timed out/);assert.match(toast.textContent,/已复制/);
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

test('observed domains can be selected in batches and exports contain only chosen domains',()=>{
 const h=harness();
 h.state.observation={id:'123',active:false,appLabel:'Banking App',appPackage:'com.private.bank'};
 h.state.observationDomains=[{domain:'ads.example',count:2},{domain:'api.example',count:1}];
 h.state.selectedObservationDomains=['ads.example','invalid;example','ads.example'];
 assert.deepEqual(Array.from(h.selectedObservationDomains()),['ads.example']);
 const panel=h.observationPanel();
 assert.match(panel,/data-action="observe-select-visible"/);
 assert.match(panel,/data-action="observe-copy-ai"/);
 assert.match(panel,/data-action="observe-export"/);
 assert.match(panel,/data-action="observe-import-personal"/);
 assert.doesNotMatch(panel,/observe-share-copy|复制社区贡献内容/);
 assert.deepEqual(h.observationExportText(),'ads.example\n');
 const prompt=h.observationAIPrompt();
 assert.match(prompt,/ads\.example/);assert.doesNotMatch(prompt,/api\.example|Banking App|com\.private\.bank/);
 assert.match(h.observationSelectionTools(),/1 个已选/);
});

test('observation pages mark only valid selected domains among large results', () => {
 const h=harness();
 h.state.observationDomains=Array.from({length:2000},(_,i)=>({domain:`domain${i}.example`,count:1}));
 h.state.selectedObservationDomains=['domain0.example','domain9.example','domain1999.example','not-observed.example','domain0.example'];
 const first=h.observationRows();
 assert.equal((first.match(/ checked>/g)||[]).length,2);
 assert.match(first,/data-observation-domain="domain0\.example"[^>]* checked>/);
 assert.match(first,/data-observation-domain="domain9\.example"[^>]* checked>/);
 h.state.observationPage=199;
 const last=h.observationRows();
 assert.equal((last.match(/ checked>/g)||[]).length,1);
 assert.match(last,/data-observation-domain="domain1999\.example"[^>]* checked>/);
});

test('shared submission link includes only selected observed domains and requires manual review',async()=>{
 const h=harness(),toast={};
 h.state.rulesView='shared';h.state.observation={appLabel:'Private Banking App',appPackage:'com.private.bank'};
 h.state.observationDomains=[{domain:'ads.example'},{domain:'api.example'}];h.state.selectedObservationDomains=['ads.example'];
 const url=new URL(h.communityIssueUrl());
 assert.equal(url.origin,'https://github.com');assert.equal(url.pathname,'/Ccmra404/AdBlock-Pro-next/issues/new');
 assert.equal(url.searchParams.get('template'),'shared-rule-candidate.md');
 const body=url.searchParams.get('body');
 assert.match(body,/ads\.example/);assert.doesNotMatch(body,/api\.example|Private Banking App|com\.private\.bank/);
 assert.match(body,/维护者会检查/);assert.match(body,/原始 DNS 查询日志/);
 h.context.document.querySelector=s=>s==='#toast'?toast:null;
 h.context.navigator={clipboard:{writeText:async text=>{h.copied=text;}}};h.context.setTimeout=()=>1;
 const button={dataset:{action:'shared-submit-candidate'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.equal(h.copied,url.href);assert.match(toast.textContent,/手动提交/);
});

test('shared candidate submission without a selection returns to observation and explains what to do',async()=>{
 const h=harness(),toast={};h.state.rulesView='shared';h.context.document.querySelector=s=>s==='#toast'?toast:null;
 vm.runInContext('render=()=>{}',h.context);h.context.setTimeout=()=>1;
 const button={dataset:{action:'shared-submit-candidate'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.equal(h.state.rulesView,'local');assert.equal(h.state.observationResultsOpen,true);assert.match(toast.textContent,/先在域名观察结果中选择候选域名/);
});

test('TXT export downloads only selected valid domains',async()=>{
 const h=harness(),downloads=[];h.state.observationDomains=[{domain:'ads.example'},{domain:'service.example'}];h.state.selectedObservationDomains=['ads.example','invalid;domain'];
 h.context.Blob=class {constructor(parts,options){this.parts=parts;this.options=options;}};
 h.context.URL={createObjectURL:blob=>{h.downloadBlob=blob;return 'blob:test';},revokeObjectURL(){}};
 h.context.document.createElement=()=>({click(){downloads.push({href:this.href,download:this.download});}});
 h.context.setTimeout=()=>1;await h.exportObservedDomains();
 assert.deepEqual(downloads,[{href:'blob:test',download:'AdBlock-Pro-observed-domains.txt'}]);
 assert.equal(h.downloadBlob.parts[0],'ads.example\n');assert.equal(h.downloadBlob.options.type,'text/plain;charset=utf-8');
});

test('device exports write UTF-8 text through the fixed module download path',async()=>{
 const h=harness();h.context.window.ksu={};
 const content='广告.example\n';
 const saving=h.saveExportFile('observed-domains',content,'AdBlock-Pro-observed-domains.txt','text/plain;charset=utf-8');
 const request=h.pending.shift();
 assert.match(request.command,/config export-file observed-domains \d+ '[A-Za-z0-9+/=]+'$/);
 const encoded=request.command.match(/'([A-Za-z0-9+/=]+)'$/)[1];
 assert.equal(Buffer.from(encoded,'base64').toString('utf8'),content);
 request.resolve({errno:0,stdout:'exported_path=/sdcard/Download/AdBlock Pro/AdBlock-Pro-observed-domains-123.txt'});
 assert.equal(await saving,'/sdcard/Download/AdBlock Pro/AdBlock-Pro-observed-domains-123.txt');
});

test('a new observation clears old selection and loaded results cannot revive it',async()=>{
 const h=harness();h.state.selectedObservationDomains=['ads.example'];h.context.setTimeout=()=>1;vm.runInContext('render=()=>{}',h.context);
 const starting=h.startJob('--observe','10',{appLabel:'Test App',appPackage:'com.test.app'});
 h.pending.shift().resolve({errno:0,stdout:'started'});await starting;
 assert.deepEqual(Array.from(h.state.selectedObservationDomains),[]);
 h.state.selectedObservationDomains=['ads.example'];h.state.observation={id:'123',startedAt:1000,active:true};
 const loading=h.loadObservationResult('123');
 h.pending.shift().resolve({errno:0,stdout:JSON.stringify([{time:'1970-01-01T00:00:02Z',question:{name:'ads.example'}}])});await new Promise(setImmediate);
 h.pending.shift().resolve({errno:0,stdout:'cleaned'});await loading;
 assert.deepEqual(Array.from(h.state.selectedObservationDomains),[]);
 assert.deepEqual(Array.from(h.state.observationDomains,domain=>domain.domain),['ads.example']);
});

test('observation shows previously seen domains again when queried in this window and merges pages',()=>{
 const h=harness();
 const page1=JSON.stringify({data:[{time:'1970-01-01T00:00:02Z',question:{name:'ads.example'}},{time:'1970-01-01T00:00:00Z',question:{name:'outside.example'}}]});
 const page2=JSON.stringify({data:[{time:'1970-01-01T00:00:03Z',question:{name:'ads.example'}},{time:'1970-01-01T00:00:03Z',question:{name:'old.example'}}]});
 const parsed=h.parseObservationSnapshot(`${page1}\n__ABP_PAGE__\n${page2}\n__ABP_META__truncated=0\n`,1000);
 assert.deepEqual(Array.from(parsed.domains,entry=>[entry.domain,entry.count]),[['ads.example',2],['old.example',1]]);
 assert.equal(parsed.truncated,false);
 h.state.observation={active:false,appLabel:'测试'};h.state.observationDomains=parsed.domains;
 assert.match(h.observationPanel(),/本次观察域名|个域名/);assert.doesNotMatch(h.observationPanel(),/个新域名/);
});

test('observation warns when the private DNS snapshot reached its page cap',()=>{
 const h=harness();h.state.observation={active:false,appLabel:'测试'};h.state.observationTruncated=true;
 h.state.observationDomains=[{domain:'ads.example',count:1}];
 assert.match(h.observationPanel(),/最多读取 2,000 条 DNS 记录，结果可能不完整/);
});

test('community candidate template requires privacy review and maintainer validation',()=>{
 const template=readFileSync(new URL('../.github/ISSUE_TEMPLATE/shared-rule-candidate.md',import.meta.url),'utf8');
 assert.match(template,/name: 共享规则候选/);assert.match(template,/原始 DNS 查询日志/);
 assert.match(template,/未经审核的候选不会进入共享规则/);
});

test('selected observed domains are imported only after explicit confirmation and do not override whitelist entries',async()=>{
 const h=harness(),modal={},toast={};
 h.state.observationDomains=[{domain:'ads.example',count:2},{domain:'allowed.example',count:1}];
 h.state.selectedObservationDomains=['ads.example','allowed.example'];
 h.state.lists.whitelist=['allowed.example'];
 h.context.document.querySelector=s=>s==='#modal'?modal:s==='#toast'?toast:null;
 h.context.setTimeout=()=>1;
 vm.runInContext('render=()=>{}',h.context);
 const button={dataset:{action:'observe-import-personal'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.equal(h.pending.length,0);assert.match(modal.innerHTML,/加入个人拦截名单/);
 const confirmed=modal.callback();
 assert.match(h.pending[0].command,/import-lists/);
 const encoded=h.pending[0].command.match(/import-lists '([^']+)'/)[1];
 assert.equal(Buffer.from(encoded,'base64').toString(),'B\tads.example\n');
 h.pending.shift().resolve({errno:0,stdout:'saved'});await new Promise(setImmediate);
 assert.match(h.pending[0].command,/config list-blacklist/);
 h.pending.shift().resolve({errno:0,stdout:'ads.example\n'});await new Promise(setImmediate);
 h.pending.shift().resolve({errno:0,stdout:'allowed.example\n'});await new Promise(setImmediate);
 assert.match(h.pending[0].command,/start \d+ --apply-personal$/);h.pending.shift().resolve({errno:0,stdout:'started'});await confirmed;
 assert.deepEqual(Array.from(h.state.selectedObservationDomains),[]);
 assert.match(toast.textContent,/已加入个人拦截名单/);
});

test('observed-domain import skips existing parent and child rules without changing the selected batch', async () => {
 const h=harness(),modal={};
 const selected=['ads.allowed.example','blocked.example','tracker.example','new.example','child.new.example'];
 h.state.observationDomains=selected.map(domain=>({domain,count:1}));
 h.state.selectedObservationDomains=selected;
 h.state.lists.whitelist=['allowed.example'];
 h.state.lists.blacklist=['blocked.example','deep.tracker.example'];
 h.context.document.querySelector=s=>s==='#modal'?modal:null;
 const button={dataset:{action:'observe-import-personal'}};
 await h.handlers.click({target:{closest:s=>s.includes('[data-action]')?button:null}});
 assert.equal(h.pending.length,0);
 assert.match(modal.innerHTML,/新增 2 个拦截域名，跳过现有黑白名单重复或重叠项 3 个/);
 assert.deepEqual(Array.from(h.state.selectedObservationDomains),selected);
});

test('AI or manual TXT import previews additions and skips existing or overlapping entries until confirmed',async()=>{
 const h=harness(),modal={},toast={};h.state.lists.blacklist=['ads.example'];h.state.lists.whitelist=['login.example'];
 h.context.document.querySelector=s=>s==='#modal'?modal:s==='#toast'?toast:null;h.context.setTimeout=()=>1;vm.runInContext('render=()=>{}',h.context);
 await h.importPersonalFile({size:100,text:async()=> '[拦截名单]\nads.example\nnew.example\n[放行名单]\nlogin.example\napi.login.example\nallow.example'});
 assert.equal(h.pending.length,0);assert.match(modal.innerHTML,/新增拦截 1 个、放行 1 个；跳过现有名单重复或冲突项 3 个/);
 const importing=modal.callback();assert.match(h.pending[0].command,/import-lists/);
 const encoded=h.pending[0].command.match(/import-lists '([^']+)'/)[1];assert.equal(Buffer.from(encoded,'base64').toString(),'B\tnew.example\nW\tallow.example\n');
 h.pending.shift().resolve({errno:0,stdout:'saved'});await new Promise(setImmediate);
 h.pending.shift().resolve({errno:0,stdout:'ads.example\nnew.example\n'});await new Promise(setImmediate);
 h.pending.shift().resolve({errno:0,stdout:'login.example\nallow.example\n'});await new Promise(setImmediate);
 assert.match(h.pending[0].command,/start \d+ --apply-personal$/);h.pending.shift().resolve({errno:0,stdout:'started'});await importing;
 assert.match(toast.textContent,/已导入 2 个个人规则/);
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
 assert.equal(h.pending.length,2);
 for(const read of h.pending.splice(0)) read.resolve({errno:0,stdout:read.command.includes('list-whitelist')?'ads.example\n':''});
 await new Promise(setImmediate);
 assert.match(h.pending[0].command,/start \d+ --apply-personal$/);h.pending.shift().resolve({errno:0,stdout:'started'});await confirmed;
 assert.deepEqual(Array.from(h.state.lists.whitelist),['ads.example']);assert.equal(h.state.job.action,'--apply-personal');assert.match(h.state.personalApplyMessage,/正在应用/);
});
