import { exec, listApplications } from './kernelsu.js';

const MODULE_DIR = '/data/adb/modules/bindhosts_personal';
const COMMAND = `sh ${MODULE_DIR}/bindhosts.sh`;
const JOB = `sh ${MODULE_DIR}/webui-job.sh`;
const DEBUG_BUILD = window.ABP_DEBUG_BUILD === true;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = { page: 'home', theme: localStorage.getItem('abp-theme') === 'dark' ? 'dark' : 'light', status: null, error: '', sourceError: '', logsError: '', listErrors: {}, sources: [], sourceRenameUrl: '', sourceEditUrl: '', logs: [], logsLoaded: false, logsLoadedAt: 0, logsPromise: null, logPage: 0, logSearch: '', lists: { whitelist: [], blacklist: [] }, listSearch: { whitelist: '', blacklist: '' }, listPage: { whitelist: 0, blacklist: 0 }, busy: false, job: null, observation: null, observationDomains: [], observationPage: 0, observationError: '', observationTruncated: false, debugSaveError: '', logFilter: 'all' };
Object.assign(state, { rulesView: 'local', sharedRules: [], sharedRevision: '', sharedUpdatedAt: 0, sharedError: '', sharedLoaded: false, sharedSearch: '', sharedPage: 0, apps: [], appsLoaded: false, appsLoading: false, appsError: '', appQuery: '', selectedApp: null, observeDuration: '10', observationResultsOpen: false, selectedObservationDomains: [] });
Object.assign(state, { aiOpen: false, aiSettingsOpen: false, aiConfig: null, aiBusy: false, aiError: '', aiResults: [], aiSelected: [], aiPage: 0, personalApplyMessage: '', personalApplyError: false });
const AI_PENDING_KEY = 'abp-ai-job';
const pages = { home: '总览', rules: '规则管理', lists: '名单', manage: '设置', logs: '运行日志' };
const LOG_PAGE_SIZE = 10;
const OBSERVATION_PAGE_SIZE = 10;
const LIST_PAGE_SIZE = 10;
const LIST_PAGINATION_THRESHOLD = 20;
const LOG_CACHE_MS = 15000;
const OBSERVE_SESSION_KEY = 'abp-observation-session';
let lastJobId = 0;
function nextJobId() { lastJobId = Math.max(Date.now(), lastJobId + 1); return String(lastJobId); }
let lastExportId = 0;
function nextExportId() { lastExportId = Math.max(Date.now(), lastExportId + 1); return String(lastExportId); }
const sourceCache = new Map();
const sourceCacheTime = new Map();
const SOURCE_CACHE_MS = 30000;
const pageFragments = new Map();
let navigationEpoch = 0;
let sourcesDisplayed = false;
const listRequestIds = { whitelist: 0, blacklist: 0 };
const listCacheTime = { whitelist: 0, blacklist: 0 };
const LIST_CACHE_MS = 20000;
let sourcePending = null;
let statusRequestId = 0;
let statusPending = null;
let jobStarting = false;

const icons = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  home: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  rules: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="7" cy="6" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="7" cy="18" r="1"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M19.4 15a2 2 0 0 0 .4 2.2l.1.1-2.6 2.6-.1-.1a2 2 0 0 0-2.2-.4 2 2 0 0 0-1.2 1.8V22h-3.6v-.1A2 2 0 0 0 9 20a2 2 0 0 0-2.2.4l-.1.1-2.6-2.6.1-.1A2 2 0 0 0 4.6 15a2 2 0 0 0-1.8-1.2H2v-3.6h.8A2 2 0 0 0 4.6 9a2 2 0 0 0-.4-2.2l-.1-.1 2.6-2.6.1.1A2 2 0 0 0 9 4.6 2 2 0 0 0 10.2 2.8V2h3.6v.8A2 2 0 0 0 15 4.6a2 2 0 0 0 2.2-.4l.1-.1 2.6 2.6-.1.1A2 2 0 0 0 19.4 9a2 2 0 0 0 1.8 1.2h.8v3.6h-.8a2 2 0 0 0-1.8 1.2Z"/>',
  logs: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="2" cy="5" r=".5"/><circle cx="2" cy="12" r=".5"/><circle cx="2" cy="19" r=".5"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a16 16 0 0 1 0 20M12 2a16 16 0 0 0 0 20"/>',
  server: '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  external: '<path d="M13 4h7v7M20 4l-9 9"/><path d="M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10h.01"/>',
  moon: '<path d="M20.5 14.5A9 9 0 0 1 9.5 3.5 9 9 0 1 0 20.5 14.5Z"/>',
  power: '<path d="M12 2v10M6.3 5.9a9 9 0 1 0 11.4 0"/>',
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.info}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const textOf = result => [result.stdout || '', result.stderr || ''].filter(Boolean).join('\n').trim();
const fmt = value => Number(value || 0).toLocaleString();
const when = seconds => Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toLocaleString() : '尚无成功更新记录';
const toast = message => { const node = $('#toast'); node.textContent = message; node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3200); };

function nav(mobile = false) {
  return Object.entries(pages).map(([id, label]) => `<button type="button" data-nav="${id}" class="${mobile ? 'mobile-item' : 'nav-btn'} ${id === state.page ? 'selected' : ''}" aria-current="${id === state.page ? 'page' : 'false'}">${icon(({ home: 'home', rules: 'rules', lists: 'globe', manage: 'settings', logs: 'logs' })[id])}<span>${label}</span></button>`).join('');
}
function toggle(key, checked, label) {
  return `<label class="switch" aria-label="${esc(label)}"><input type="checkbox" data-toggle="${key}" ${checked ? 'checked' : ''}><span class="track"></span></label>`;
}
function tag(label, color = '') { return `<span class="tag ${color}">${esc(label)}</span>`; }
function row(ico, title, subtitle, end) { return `<div class="rowitem"><div class="rowleft"><span class="rowicon">${icon(ico)}</span><div><div class="rowname">${esc(title)}</div><div class="rowdesc">${esc(subtitle)}</div></div></div>${end}</div>`; }
function heading(title, subtitle, action = '') { return `<div class="heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`; }
function layout(content) {
  document.documentElement.dataset.theme = state.theme;
  const sideState = state.status?.state === 'active' ? '防护已连接' : state.status?.state === 'paused' ? '服务已停止' : state.status?.state === 'bypassed' ? '系统接管已关闭' : '检查服务状态';
  const app = $('#app .app');
  if (app) {
    $('#page-content').innerHTML = content;
    $$('[data-nav]').forEach(button => {
      const selected = button.dataset.nav === state.page;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    $('.breadcrumb b').textContent = pages[state.page];
    const sideLabel = $('.side-footer strong');
    sideLabel.innerHTML = `<span class="dot ${state.status?.state === 'active' ? 'on' : 'warn'}"></span> ${sideState}`;
    $('.side-footer p').textContent = state.error ? '请通过支持 Root 接口的管理器或 WebUI 宿主打开本模块。' : '状态来自模块与 AdGuard Home 后端实时查询。';
    const connectionTag = $('.top-actions .tag');
    connectionTag.classList.toggle('green', Boolean(state.status));
    connectionTag.textContent = state.status ? '设备已连接' : '等待设备';
    return;
  }
  $('#app').innerHTML = `<div class="app"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon('shield')}</span><div><div class="brand-title">AdBlock Pro</div><div class="brand-sub">Root · DNS 过滤</div></div></div><nav class="side-nav" aria-label="主导航">${nav()}</nav><div class="side-footer"><strong><span class="dot ${state.status?.state === 'active' ? 'on' : 'warn'}"></span> ${sideState}</strong><p>${state.error ? '请通过支持 Root 接口的管理器或 WebUI 宿主打开本模块。' : '状态来自模块与 AdGuard Home 后端实时查询。'}</p></div></aside><main class="container"><header class="topbar"><div class="breadcrumb">AdBlock Pro <span style="padding:0 7px">/</span><b>${pages[state.page]}</b></div><div class="mobile-brand"><span class="brand-mark">${icon('shield')}</span>AdBlock Pro</div><div class="top-actions"><span class="tag ${state.status ? 'green' : ''}">${state.status ? '设备已连接' : '等待设备'}</span><button class="theme-btn" data-action="theme" aria-label="切换深浅色">${icon('moon')}</button></div></header><div id="page-content">${content}</div><footer class="footnote">AdBlock Pro · Root WebUI</footer></main><nav class="mobile-nav" aria-label="移动端导航">${nav(true)}</nav></div>`;
}
function summaryText() {
  const s = state.status;
  if (state.error) return ['设备状态暂不可用', '后端状态读取失败，当前数据可能已经过期。请检查管理器的 Root WebUI 连接。'];
  if (!s) return ['正在读取设备状态', '正在读取本机 AdGuard Home 状态。'];
  if (s.dns_core_running === '0' || s.state === 'paused') return ['DNS 核心已停止', '系统 DNS 未接入本地过滤服务。'];
  if (s.dns_health === 'listener_failed' || s.dns_listener === '0') return ['DNS 监听异常', '核心进程存在，但 TCP/UDP DNS 监听未全部就绪。请查看环境检测。'];
  if (s.dns_health === 'api_failed') return ['DNS 管理接口异常', '核心进程存在，但无法读取 AdGuard Home API。请查看环境检测。'];
  if (s.dns_health === 'takeover_cleanup_pending') return ['系统接管尚未清理', '已保存关闭偏好，但仍检测到本模块重定向。请检查后再停止核心。'];
  if (s.dns_takeover === 'off') return ['已关闭系统接管，DNS 核心仍运行', '这是已保存的关闭偏好；系统 DNS 不会经过本模块过滤。可在设置中重新开启。'];
  if (s.dns_health === 'takeover_unknown') return ['系统接管偏好无法读取', '未确认已保存的接管设置，请查看环境检测。'];
  if (s.dns_redirect === '0') return ['系统 DNS 接管未成功', 'DNS 核心正在运行，但本模块重定向尚未应用。请查看环境检测。'];
  if (s.state === 'degraded') return ['DNS 服务未完全就绪', '检查监听端口和 DNS 接管状态。'];
  if (s.filtering_enabled === 'false') return ['DNS 服务已接管，过滤已暂停', '解析仍由 AdGuard Home 处理，广告规则暂不拦截。'];
  return ['广告防护已开启', 'AdGuard Home DNS 引擎与系统 DNS 接管均已就绪。'];
}
function coreRunning(s = state.status) {
  return s?.dns_core_running !== undefined ? s.dns_core_running === '1'
    : ['active', 'degraded', 'bypassed'].includes(s?.state);
}
function queryTotal(stats) {
  if (!stats) return null;
  if (Number.isFinite(Number(stats.num_dns_queries))) return Number(stats.num_dns_queries);
  const values = stats.dns_queries;
  if (Array.isArray(values)) return values.reduce((sum, item) => sum + (Number(item) || 0), 0);
  if (values && typeof values === 'object') return Object.values(values).reduce((sum, item) => sum + (Number(item) || 0), 0);
  return null;
}
function memoryView(s = state.status) {
  const rss = Number(s?.dns_rss_kb), pss = Number(s?.dns_pss_kb);
  if (!Number.isFinite(rss) || rss <= 0 || (Number.isFinite(pss) && pss > rss))
    return { value: '—', label: 'RSS 无法读取 · 可尝试环境检测' };
  const sampled = s?.dns_mem_source === 'rollup_sample' || s?.dns_mem_source === 'smaps_rollup';
  return {
    value: (rss / 1024).toFixed(1),
    label: sampled ? `诊断采样 RSS · ${when(s.dns_mem_sampled_at)}${pss > 0 ? ` · PSS ${(pss / 1024).toFixed(1)} MB` : ''}`
      : 'RSS 估计 · 环境检测可精确采样',
  };
}
function homePage() {
  const s = state.status;
  const [title, subtitle] = summaryText();
  const stats = s?.dns_stats_json || null;
  const queryCount = queryTotal(stats);
  const memory = memoryView(s);
  const headAction = `<button class="btn" data-action="diagnose">${icon('activity')} 环境诊断</button>`;
  return `${heading('总览', '查看过滤与 DNS 服务状态', headAction)}
    <div class="stack">
      <section class="panel hero"><div class="hero-content"><span class="hero-symbol ${s?.state === 'active' ? '' : 'off'}">${icon(s?.state === 'active' ? 'shield' : 'power')}</span><div><div class="hero-title">${esc(title)}</div><div class="hero-sub">${esc(subtitle)}</div><div class="status-pills"><span class="mini-status"><i class="dot ${coreRunning(s) ? 'on' : 'warn'}"></i> DNS ${coreRunning(s) ? '运行中' : s ? '已停止' : '待检查'}</span><span class="mini-status"><i class="dot ${s?.dns_redirect === '1' ? 'on' : 'warn'}"></i> DNS 重定向 ${s?.dns_redirect === '1' ? '已应用' : '未应用'}</span></div></div></div>${toggle('filtering', s?.filtering_enabled === 'true', '广告规则过滤')}</section>
      <section class="metrics" aria-label="设备实时统计"><div class="metric"><div class="metric-label">已加载规则条目</div><div class="metric-value">${s ? fmt(s.blocked) : '—'}</div><div class="metric-foot">不是广告命中次数</div></div><div class="metric"><div class="metric-label">DNS 查询统计</div><div class="metric-value">${queryCount === null ? '—' : fmt(queryCount)}</div><div class="metric-foot">AdGuard Home 统计接口</div></div><div class="metric"><div class="metric-label">DNS 核心内存</div><div class="metric-value">${memory.value} <span style="font-size:14px">MB</span></div><div class="metric-foot">${esc(memory.label)}</div></div></section>
      <section class="panel" data-service-status><div class="panel-head"><div><h2 class="section-title">服务状态</h2><p class="section-sub">模块与独立应用状态</p></div></div><div class="rows">${row('server', 'AdGuard Home', '本地 DNS 过滤核心', tag(coreRunning(s) ? '运行中' : s ? '已停止' : '未知', coreRunning(s) ? 'green' : 'yellow'))}${row('globe', '系统 DNS 接管', '仅接管模块管理的 IPv4 DNS 规则', tag(s?.dns_redirect === '1' ? '重定向已应用' : s?.dns_takeover === 'off' ? '主动关闭' : '未重定向', s?.dns_redirect === '1' ? 'green' : 'yellow'))}${row('activity', 'GKD 开屏跳过', '由 GKD 独立管理', tag('独立应用'))}</div></section>
      <section class="panel"><div class="panel-head"><div><h2 class="section-title">最近规则更新</h2><p class="section-sub">${esc(s ? when(s.last_update) : '读取中')}</p></div><button class="btn" data-nav="rules">规则管理</button></div><div class="notice">${icon('info')}<span>仅显示设备实际返回的数据。当前模块不采集每次 DNS 请求或广告命中日志。</span></div></section>
    </div>`;
}
function sourceRows() {
  if (!state.sources.length) return `<div class="empty-state">${esc(state.sourceError || '正在读取规则来源…')}</div>`;
  const rows = state.sources.map(source => {
    const enabled = source.enabled === 'enabled';
    const renaming = state.sourceRenameUrl === source.url;
    const editing = state.sourceEditUrl === source.url;
    const detail = source.url === 'shared' ? '维护者审核的共享抓包规则' : source.url;
    const shared = source.url === 'shared' ? state.status?.dns_filter_json?.filters?.find(x => x.url?.endsWith('/adblock-pro-shared-app-rules.txt')) : null;
    const actions = `<div class="source-actions"><button class="btn" data-action="source-toggle" data-url="${esc(source.url)}" data-enabled="${source.enabled}">${enabled ? '停用' : '导入'}</button>${source.url === 'shared' ? '' : `<button class="btn" data-action="source-url-open" data-url="${esc(source.url)}">修改链接</button>`}<button class="btn" data-action="source-rename-open" data-url="${esc(source.url)}">重命名</button><button class="btn btn-danger" data-action="source-delete" data-url="${esc(source.url)}">移除</button></div>`;
    const rename = renaming ? `<form class="source-rename-form btn-row" data-url="${esc(source.url)}"><input class="field" name="name" maxlength="64" value="${esc(source.label)}" aria-label="规则来源名称" required><button class="btn btn-primary" type="submit">保存名称</button><button class="btn" type="button" data-action="source-rename-cancel">取消</button></form>` : '';
    const edit = editing ? `<form class="source-edit-form btn-row" data-url="${esc(source.url)}"><input class="field" name="url" type="url" value="${esc(source.url)}" aria-label="规则订阅链接" autocapitalize="none" required><button class="btn btn-primary" type="submit">保存链接</button><button class="btn" type="button" data-action="source-url-cancel">取消</button></form>` : '';
    const subtitle = source.url === 'shared' ? `${detail} · ${shared ? fmt(shared.rules_count) + ' 条已加载' : '随模块预置'}` : detail;
    return `<div class="source-row" data-source-url="${esc(source.url)}"><div class="source-copy"><strong>${esc(source.label)}</strong><small>${esc(subtitle)}</small></div><span class="tag ${enabled ? 'green' : ''}">${enabled ? '已启用' : '未导入'}</span>${actions}${rename}${edit}</div>`;
  }).join('');
  return rows;
}
function ruleList(kind) {
  const items = state.lists[kind] || [];
  const title = kind === 'whitelist' ? '放行名单' : '拦截名单';
  const placeholder = kind === 'whitelist' ? 'login.example.com' : 'ads.example.com';
  return `<section class="panel"><div class="panel-head"><div><h2 class="section-title">${title}</h2><p class="section-sub">${kind === 'whitelist' ? '允许指定域名通过过滤' : '拦截指定域名'}</p></div><span class="tag" data-list-total="${kind}">${fmt(items.length)} 条</span></div><form class="btn-row domain-form" data-kind="${kind}"><input class="field" name="domain" placeholder="${placeholder}" autocapitalize="none" spellcheck="false" required><button class="btn" type="submit">添加</button></form><p class="field-help">修改后自动应用个人名单，无需更新订阅。</p><input class="field list-search" type="search" data-search-list="${kind}" value="${esc(state.listSearch[kind])}" placeholder="搜索${title}" style="margin-top:10px"><p class="field-help list-help">20 条以内全部显示；更多时每页显示 10 条。搜索范围为完整名单。</p><div class="list-results" data-list-results="${kind}" aria-live="polite">${listResultsMarkup(kind)}</div></section>`;
}
function listResultsMarkup(kind) {
  const items = state.lists[kind] || [];
  const query = state.listSearch[kind].trim().toLowerCase();
  const matches = query ? items.filter(domain => domain.toLowerCase().includes(query)) : items;
  const needsPagination = matches.length > LIST_PAGINATION_THRESHOLD;
  const pageCount = needsPagination ? Math.ceil(matches.length / LIST_PAGE_SIZE) : 1;
  state.listPage[kind] = Math.min(state.listPage[kind], pageCount - 1);
  const start = needsPagination ? state.listPage[kind] * LIST_PAGE_SIZE : 0;
  const visible = needsPagination ? matches.slice(start, start + LIST_PAGE_SIZE) : matches;
  const rows = visible.map(domain => row('globe', domain, '', `<button class="btn btn-danger" data-action="list-delete" data-kind="${kind}" data-domain="${esc(domain)}">删除</button>`)).join('');
  if (!matches.length) return `<div class="empty-state">${esc(query ? '没有符合条件的域名' : state.listErrors[kind] || '暂无域名')}</div>`;
  const pagination = needsPagination ? `<nav class="list-pagination logs-pagination" aria-label="${kind === 'whitelist' ? '放行' : '拦截'}名单分页"><button class="btn" data-action="list-page" data-kind="${kind}" data-page="${state.listPage[kind] - 1}" ${state.listPage[kind] === 0 ? 'disabled' : ''}>上一页</button><span>第 ${state.listPage[kind] + 1} / ${pageCount} 页 · ${start + 1}–${start + visible.length} 条，共 ${matches.length} 条</span><button class="btn" data-action="list-page" data-kind="${kind}" data-page="${state.listPage[kind] + 1}" ${state.listPage[kind] >= pageCount - 1 ? 'disabled' : ''}>下一页</button></nav>` : query ? `<p class="list-match-count">匹配 ${matches.length} 条</p>` : '';
  return `<div class="rows list-values" data-list="${kind}">${rows}</div>${pagination}`;
}
function renderListResults(kind) {
  const results = $(`[data-list-results="${kind}"]`);
  if (results) results.innerHTML = listResultsMarkup(kind);
}
function resetListView(kind) {
  state.listSearch[kind] = '';
  state.listPage[kind] = 0;
}
function rulesPage() {
  const s = state.status;
  const selectedCount = state.sources.filter(source => source.enabled === 'enabled').length;
  return `${heading('规则管理', '来源、更新与历史回滚')}
    <div class="stack"><section id="update-progress" class="panel progress-card hidden" aria-live="polite"><div class="panel-head"><b class="section-title">规则更新</b><span id="update-elapsed" class="small muted"></span></div><div id="update-stage" class="small">等待任务</div><div class="progress-track"><span class="progress-bar"></span></div><p id="update-help" class="field-help">下载期间本页面仍可切换；不要重复启动更新。</p></section>
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">规则来源</h2><p class="section-sub">逐项导入、停用、移除或重命名；订阅内容先下载校验，再交给本地 DNS 核心加载</p></div><span class="tag" data-source-count>${state.sourceError ? (state.sourceError === '正在读取规则来源…' ? '加载中' : '设备未连接') : `${selectedCount} 个已启用`}</span></div><div id="source-list" class="source-list">${sourceRows()}</div><form id="source-form" class="btn-row"><input class="field" name="name" maxlength="64" placeholder="来源名称" required><input class="field" name="url" type="url" placeholder="HTTPS 订阅地址" autocapitalize="none" required><button class="btn" type="submit">导入来源</button></form><p id="rules-feedback" class="field-help" aria-live="polite">默认来源也可以停用或移除；移除内置来源只从当前订阅中移除，仍可随时重新导入。更新失败会保留上一版规则。</p><div class="divider"></div><div class="btn-row"><button class="btn btn-primary" data-action="update">立即检查并更新</button><select id="history-select" class="field" aria-label="选择要恢复的规则历史"><option value="">选择历史版本</option>${(s?.history || []).map(item => { const [key, count] = item.split(':'); return `<option value="${esc(key)}">${esc(key.slice(0,4)+'-'+key.slice(4,6)+'-'+key.slice(6,8)+' '+key.slice(8,10)+':'+key.slice(10,12))} · ${fmt(count)} 条</option>`; }).join('')}</select><button class="btn btn-danger" data-action="rollback">恢复</button></div></section>
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">域名检查</h2><p class="section-sub">查询域名当前是否命中 AdGuard Home 规则</p></div></div><form id="domain-form" class="btn-row"><input class="field" name="domain" placeholder="例如 ads.example.com" autocapitalize="none" required><button class="btn" type="submit">检查</button></form><p id="domain-result" class="field-help">检查结果由设备本地过滤服务返回。</p></section></div>`;
}
function personalRulesPage() {
  if (state.rulesView === 'shared') return sharedRulesPage();
  const blocked = state.lists.blacklist || [];
  const allowed = state.lists.whitelist || [];
  return `${heading('个人规则', '本机名单独立保存；共享抓包规则供各设备同步 · 导出到 Download/AdBlock Pro', '<div class="btn-row"><button class="btn" data-action="personal-rules-apply">应用个人名单</button><button class="btn" data-action="personal-rules-import">导入</button><button class="btn" data-action="personal-rules-export">导出</button></div>')}<input id="personal-rules-file" type="file" accept=".txt,.json,text/plain,application/json" hidden>
    <div class="stack">${observationPanel()}<section class="panel personal-summary"><div class="panel-head"><div><h2 class="section-title">名单概览</h2><p class="section-sub">仅统计本机个人规则，不含订阅规则和 DNS 查询记录</p></div>${tag(`${blocked.length + allowed.length} 条`)}</div><p id="personal-apply-status" class="field-help${state.personalApplyError ? ' notice warn' : ''}" role="status">${esc(state.personalApplyMessage || '修改名单后自动单独应用；失败可点“应用个人名单”重试。')}</p><div class="personal-counts"><div><strong>${fmt(blocked.length)}</strong><span>拦截域名</span></div><div><strong>${fmt(allowed.length)}</strong><span>放行域名</span></div></div></section><div class="twocol">${ruleList('blacklist')}${ruleList('whitelist')}</div><button type="button" class="panel shared-entry" data-action="shared-open"><span>${icon('globe')}<strong>共享抓包规则库</strong></span><span>查看与同步 ${icon('external')}</span></button></div>`;
}
function sharedResultsMarkup() {
  const query = state.sharedSearch.trim().toLowerCase();
  const matches = state.sharedRules.filter(x => x.includes(query));
  const pageCount = Math.max(1, Math.ceil(matches.length / LIST_PAGE_SIZE));
  state.sharedPage = Math.min(state.sharedPage, pageCount - 1);
  const start = state.sharedPage * LIST_PAGE_SIZE;
  const rows = matches.slice(start, start + LIST_PAGE_SIZE).map(domain => row('globe', domain, '', '')).join('');
  return `<div class="rows">${rows || `<div class="empty-state">${state.sharedLoaded ? '没有符合条件的域名' : '正在读取共享规则…'}</div>`}</div><nav class="logs-pagination" aria-label="共享规则分页"><button class="btn" data-action="shared-page" data-page="${state.sharedPage - 1}" ${state.sharedPage === 0 ? 'disabled' : ''}>上一页</button><span>${state.sharedPage + 1} / ${pageCount} 页 · ${matches.length} 条</span><button class="btn" data-action="shared-page" data-page="${state.sharedPage + 1}" ${state.sharedPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button></nav>`;
}
function renderSharedResults() {
  const node = $('#shared-results'); if (node) node.innerHTML = sharedResultsMarkup();
}
function sharedRulesPage() {
  const syncing = state.job?.action === '--sync-shared';
  return `${heading('共享抓包规则库', '维护者确认后发布，各设备使用同一份公开名单', '<button class="btn" data-action="shared-back">返回个人规则</button>')}
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">共享规则</h2><p class="section-sub">10007、秋风 AdGuard 全规则和本规则库共同构成模块基础</p></div>${tag(`${state.sharedRules.length} 条`)}</div><p class="field-help">修订 ${esc(state.sharedRevision || '—')} · ${state.sharedUpdatedAt ? new Date(state.sharedUpdatedAt * 1000).toLocaleString('zh-CN') : '随模块预置'}。同步会读取 GitHub 上已确认的规则，保留本机个人黑白名单；放行名单可以覆盖共享规则。</p><div class="btn-row"><button class="btn btn-primary" data-action="shared-sync" ${syncing ? 'disabled' : ''}>${syncing ? '正在同步…' : '同步并应用'}</button><button class="btn" data-action="shared-source-add">加入规则来源</button><button class="btn" data-action="shared-submit-candidate">提交候选${selectedObservationDomains().length ? `（${fmt(selectedObservationDomains().length)}）` : ''}</button></div><p class="field-help">候选只包含你在域名观察中勾选的域名。按钮会复制 GitHub 草稿链接；检查内容后由你手动提交，维护者审核通过后才会进入共享规则。</p>${state.sharedError ? `<div class="notice warn">${esc(state.sharedError)}</div>` : ''}<input id="shared-search" class="field" type="search" value="${esc(state.sharedSearch)}" placeholder="搜索共享域名" aria-label="搜索共享域名"><div id="shared-results">${sharedResultsMarkup()}</div></section>`;
}
function managePage() {
  const s = state.status;
  return `${heading('系统设置', '管理 DNS 接管、自动运行与维护')}
    <div class="stack"><section class="panel"><div class="panel-head"><div><h2 class="section-title">运行设置</h2><p class="section-sub">过滤暂停不会关闭 DNS 核心；DNS 接管可单独撤销</p></div></div><div class="rows">${row('globe','DNS 接管','控制本模块的 DNS 重定向规则',toggle('takeover',s?.dns_takeover === 'on','DNS 接管'))}${row('power','开机自动运行','关闭后下次开机不自动启动核心',toggle('autostart',s?.autostart !== 'off','开机自动运行'))}${row('refresh','每日自动更新','由 AdGuard Home 按每日周期更新规则',toggle('auto-update',s?.auto_update !== 'off','每日自动更新'))}</div><div class="notice warn" style="margin-top:14px">${icon('info')}<span>此模块只接管 IPv4 明文 DNS。私人 DNS、VPN、应用内 DoH/DoT 可能绕过过滤；IPv6 DNS 不接管。</span></div></section>
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">运行维护</h2><p class="section-sub">诊断结果统一保存在运行日志中</p></div></div><div class="btn-row"><button class="btn" data-action="diagnose">${icon('activity')} 运行诊断</button><button class="btn" data-action="restart">${icon('refresh')} 重启 DNS 核心</button><button class="btn btn-danger" data-action="disable-takeover">${icon('power')} 紧急解除接管</button><button class="btn" data-nav="logs">查看运行日志</button></div></section>
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">恢复默认设置</h2><p class="section-sub">按当前安装包的默认状态重新初始化模块</p></div></div><p class="field-help">会重置订阅源及名称、个人黑白名单、AI 接口密钥、AdGuard Home 账号与设置（后台恢复为 admin/password）、规则缓存、共享快照、日志和历史。DNS 接管恢复为 IPv4 默认开启，IPv6 接管仍关闭。操作前会在 Download/AdBlock Pro 创建本机备份。</p><button class="btn btn-danger" data-action="restore-defaults">${icon('refresh')} 恢复默认设置</button></section>
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">管理入口</h2><p class="section-sub">规则高级配置由 AdGuard Home 原生后台提供</p></div></div><div class="action-grid"><a class="action-card" href="http://127.0.0.1:3000/" target="_blank" rel="noopener">${icon('external')}<span class="action-text"><strong>AdGuard Home 后台</strong><small>订阅、上游 DNS 与查询日志</small></span></a><button type="button" class="action-card" data-action="copy-gkd-link">${icon('activity')}<span class="action-text"><strong>GKD 项目</strong><small>复制项目链接，在浏览器中查看</small></span></button><button type="button" class="action-card" data-action="ai-settings">${icon('settings')}<span class="action-text"><strong>AI 域名分析</strong><small>DeepSeek 或自定义兼容接口</small></span></button></div><p class="field-help">WebUI 不保存或展示 AdGuard Home 管理密码；首次登录凭据由安装包单独提供。</p></section><div id="ai-settings-panel">${aiSettingsMarkup()}</div></div>`;
}
const actionNames = { '--apply-personal': '应用个人名单', '--sync-shared': '同步共享规则', 'import-lists': '导入个人名单', 'export-rules': '导出规则', '--update': '规则更新', '--pause': '暂停过滤核心', '--resume': '启动过滤核心', '--rollback': '恢复规则', '--rollback-history': '恢复历史规则', '--filtering': '过滤开关', '--takeover': 'DNS 接管', '--restart': '重启 DNS 核心', '--factory-reset': '恢复默认设置', '--diagnose': '环境诊断', '--observe': '域名观察', diagnose: '环境诊断', 'set-mode': '切换过滤模式', 'set-source': '切换规则来源', 'add-source': '导入规则来源', 'remove-source': '删除规则来源', 'add-whitelist': '添加白名单', 'remove-whitelist': '删除白名单', 'add-blacklist': '添加黑名单', 'remove-blacklist': '删除黑名单', 'auto-update': '自动更新设置', autostart: '开机运行设置' };
function logRow(line) {
  const [id, status, action, argument, summary] = line.split('\t');
  if (!/^\d{1,20}$/.test(id || '')) return '';
  const time = new Date(Number(id)).toLocaleString();
  return `<article class="log-event ${esc(status)}" data-status="${esc(status)}" data-search="${esc(`${actionNames[action] || action} ${argument} ${summary} ${time}`.toLowerCase())}"><span class="log-icon">${status === 'success' ? '✓' : status === 'failure' ? '!' : 'i'}</span><div><div class="log-event-head"><b>${esc(actionNames[action] || '模块操作')}</b><time>${esc(time)}</time></div><div class="log-event-summary">${esc(summary || argument || '操作已记录')}</div><span class="log-tag">${status === 'success' ? '成功' : status === 'failure' ? '提醒' : '进行中'}</span><details class="log-command-details" data-log-id="${esc(id)}"><summary>查看命令输出</summary><pre class="log-command-output">展开后读取</pre></details></div></article>`;
}
function matchingLogs() {
  const query = state.logSearch.trim().toLowerCase();
  return state.logs.filter(line => {
    const [id, status, action, argument, summary] = line.split('\t');
    if (!/^\d{1,20}$/.test(id || '') || (state.logFilter !== 'all' && status !== state.logFilter)) return false;
    const time = new Date(Number(id)).toLocaleString();
    return `${actionNames[action] || action} ${argument} ${summary} ${time}`.toLowerCase().includes(query);
  });
}
function logListMarkup() {
  if (!state.logsLoaded && !state.logs.length) return `<div class="empty-state">${esc(state.logsError || '正在读取日志…')}</div>`;
  const matches = matchingLogs();
  if (!matches.length) return `<div class="empty-state">${esc(state.logsError || (state.logs.length ? '没有符合条件的日志' : '暂无操作记录'))}</div>`;
  const pageCount = Math.ceil(matches.length / LOG_PAGE_SIZE);
  state.logPage = Math.min(state.logPage, pageCount - 1);
  const start = state.logPage * LOG_PAGE_SIZE;
  const visible = matches.slice(start, start + LOG_PAGE_SIZE);
  return `${visible.map(logRow).join('')}<nav class="logs-pagination" aria-label="日志分页"><button class="btn" data-action="logs-page" data-page="${state.logPage - 1}" ${state.logPage === 0 ? 'disabled' : ''}>上一页</button><span>第 ${state.logPage + 1} / ${pageCount} 页 · ${start + 1}–${start + visible.length} 条，共 ${matches.length} 条</span><button class="btn" data-action="logs-page" data-page="${state.logPage + 1}" ${state.logPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button></nav>`;
}
function renderLogList() {
  const list = $('#log-list');
  if (list) list.innerHTML = logListMarkup();
}
function domainInList(domain, list) {
  return (list || []).some(item => domain === item || domain.endsWith(`.${item}`));
}
function domainTouchesList(domain, list) {
  return (list || []).some(item => domain === item || domain.endsWith(`.${item}`) || item.endsWith(`.${domain}`));
}
function classifyObservedDomain(item) {
  const domain = item.domain;
  if (domainInList(domain, state.lists.whitelist)) return { label: '白名单', tone: 'yellow', add: false };
  if (domainInList(domain, state.lists.blacklist)) return { label: '个人规则', tone: 'green', add: false };
  const reason = String(item.reason || '');
  if (/^Filtered/i.test(reason) || (Number(item.filterId) > 0 && !/^NotFiltered/i.test(reason))) return { label: '订阅已拦截', tone: 'green', add: false };
  const adHint = /(^|[.-])(ad|ads|advert|advertising|adserver|gdt|ssp|dsp|tracker|tracking|track|analytics|telemetry|beacon|promotion|promo|click|stat|metrics)([.-]|$)/i.test(domain);
  return adHint ? { label: '疑似广告/跟踪', tone: 'yellow', add: true } : { label: '未识别，需核对', tone: '', add: true };
}
function selectedObservationDomains() {
  const observed = new Set(state.observationDomains.map(item => item.domain));
  return [...new Set(state.selectedObservationDomains || [])].filter(domain => validObservedDomain(domain) && observed.has(domain));
}
function observationExportText() {
  const selected = selectedObservationDomains();
  return selected.length ? `${selected.join('\n')}\n` : '';
}
function observationSelectionTools() {
  const selected = selectedObservationDomains();
  const start = state.observationPage * OBSERVATION_PAGE_SIZE;
  const visible = state.observationDomains.slice(start, start + OBSERVATION_PAGE_SIZE).map(item => item.domain).filter(validObservedDomain);
  const allVisibleSelected = visible.length > 0 && visible.every(domain => selected.includes(domain));
  const disabled = selected.length ? '' : 'disabled';
  const aiDisabled = state.aiBusy || !selected.length || selected.length > 50;
  const aiLabel = state.aiBusy ? 'AI 分析中…' : selected.length > 50 ? 'AI 一次最多 50 个' : `AI 分析所选（${selected.length}）`;
  return `<div class="observe-selection-tools"><div class="observe-selection-head"><b>${fmt(selected.length)} 个已选</b><button class="btn" data-action="observe-select-all" ${state.observationDomains.length ? '' : 'disabled'}>全选全部</button><button class="btn" data-action="observe-select-visible" ${visible.length ? '' : 'disabled'}>${allVisibleSelected ? '取消本页选择' : '全选本页'}</button><button class="btn" data-action="observe-clear-selection" ${disabled}>取消全选</button></div><div class="btn-row observe-export-actions"><button class="btn" data-action="observe-copy-domains" ${disabled}>复制域名</button><button class="btn" data-action="observe-export" ${disabled}>导出 TXT</button><button class="btn" data-action="ai-open" ${aiDisabled ? 'disabled' : ''}>${aiLabel}</button>${state.aiResults.length ? '<button class="btn" data-action="ai-view-results">查看 AI 结果</button>' : ''}<button class="btn" data-action="observe-copy-ai" ${disabled}>复制给外部 AI</button><button class="btn" data-action="observe-import-personal" ${disabled}>导入个人拦截规则</button></div><p class="field-help">先勾选候选域名；复制、导出和导入只处理勾选的域名，不含应用名、设备标识或原始 DNS 日志。提交共享候选请前往共享规则库。</p></div>`;
}
function observationAIPrompt() {
  return `请分析下面这些在短时 DNS 观察中出现的候选域名。观察期间可能混入后台应用请求，请将每项谨慎分为“疑似广告/跟踪”“疑似正常服务”“无法判断”，说明判断依据，不要声称仅凭域名可以确定。只返回输入中已有的域名，不要编造域名。最后只输出可导入的纯文本，不要代码围栏、解释文字或列表标记：\n[拦截名单]\n<仅放入有较强广告/跟踪证据的域名>\n\n[放行名单]\n<确认属于必要服务且用户希望放行的域名>\n\n候选域名：\n${selectedObservationDomains().join('\n')}`;
}
function communityIssueUrl(domains = selectedObservationDomains()) {
  if (!domains.length) throw new Error('请先在域名观察结果中选择候选域名');
  const title = `[规则候选] ${domains.length} 个域名`;
  const body = `## 候选域名\n\n每行一个完整域名。请只提交你愿意公开的域名。\n\n\`\`\`text\n${domains.join('\n')}\n\`\`\`\n\n## 观察说明\n\n来自短时 DNS 域名观察的候选，可能混入后台请求，尚待人工核验。\n\n## 隐私确认\n\n- [ ] 我检查过内容，只包含我愿意公开的域名与说明。\n- [ ] 我没有附上原始 DNS 查询日志、应用名称、设备标识、IP 地址、账号信息或其他个人数据。\n\n维护者会检查格式、重复项、误拦截风险及必要服务影响；未经审核的候选不会进入共享规则，也不会影响其他用户。`;
  return `https://github.com/Ccmra404/AdBlock-Pro-next/issues/new?template=shared-rule-candidate.md&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
async function copyText(text) {
  if (!text) throw new Error('没有可复制的内容');
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Fall through for older WebView hosts. */ }
  }
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.appendChild(field); field.select();
  const copied = document.execCommand('copy'); field.remove();
  if (!copied) throw new Error('当前宿主无法复制，请长按选择文本后重试');
}
function renderObservationSelection() {
  const selected = selectedObservationDomains();
  $$('[data-observation-domain]').forEach(input => { input.checked = selected.includes(input.dataset.observationDomain); });
  const tools = $('#observation-selection-tools'); if (tools) tools.innerHTML = observationSelectionTools();
  if (state.aiOpen) renderAI();
}
function observationRows() {
  if (!state.observationDomains.length) return `<div class="empty-state">本次没有记录到经过 AdGuard Home 的 DNS 域名。旧域名只要在本次观察中再次查询也会显示；缓存、应用自带 DoH/HTTPDNS 或绕过模块的 VPN 请求可能不可见。</div>`;
  const candidateCount = state.observationDomains.length;
  const pageCount = Math.ceil(candidateCount / OBSERVATION_PAGE_SIZE);
  state.observationPage = Math.min(state.observationPage, pageCount - 1);
  const start = state.observationPage * OBSERVATION_PAGE_SIZE;
  const visible = state.observationDomains.slice(start, start + OBSERVATION_PAGE_SIZE);
  return `${visible.map(item => {
    const classification = classifyObservedDomain(item);
    const action = `<div class="btn-row">${classification.add ? `<button class="btn" data-action="observe-add" data-domain="${esc(item.domain)}">拦截</button>` : ''}${!domainInList(item.domain, state.lists.whitelist) ? `<button class="btn" data-action="observe-allow" data-domain="${esc(item.domain)}">放行</button>` : ''}</div>`;
    const selected = selectedObservationDomains().includes(item.domain);
    return `<div class="observe-row"><label class="observe-select"><input type="checkbox" data-observation-domain="${esc(item.domain)}" aria-label="选择 ${esc(item.domain)}" ${selected ? 'checked' : ''}></label><div class="observe-copy"><strong>${esc(item.domain)}</strong><small>${fmt(item.count)} 次请求${item.filterId ? ` · 规则 ${esc(item.filterId)}` : ''}</small></div>${tag(classification.label, classification.tone)}${action}</div>`;
  }).join('')}<nav class="observe-pagination logs-pagination" aria-label="观察结果分页"><button class="btn" data-action="observe-page" data-page="${state.observationPage - 1}" ${state.observationPage === 0 ? 'disabled' : ''}>上一页</button><span>第 ${state.observationPage + 1} / ${pageCount} 页 · ${start + 1}–${start + visible.length} 条，共 ${candidateCount} 条</span><button class="btn" data-action="observe-page" data-page="${state.observationPage + 1}" ${state.observationPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button></nav>`;
}
function observationPanel() {
  const observation = state.observation;
  const active = observation?.active && state.job?.action === '--observe';
  const remaining = active ? Math.max(0, Math.ceil((observation.startedAt + observation.duration * 1000 - Date.now()) / 1000)) : 0;
  const status = active ? `<div id="observe-progress" class="notice observe-progress" role="status">${icon('activity')}<span>记录中 · 约 ${remaining} 秒后分析。${esc(observation.appLabel || '目标应用')}已重新打开，请复现广告，然后返回此页。</span></div>` : '';
  const error = state.observationError ? `<div class="notice warn observe-error">${icon('info')}<span>${esc(state.observationError)}${observation?.id ? ` <button class="btn btn-plain" data-action="observe-retry">重试读取</button>` : ''}</span></div>` : '';
  const truncation = state.observationTruncated ? '<div class="notice warn" role="status">请求量较高或后续分页读取失败，本次最多读取 2,000 条 DNS 记录，结果可能不完整。</div>' : '';
  const debugNotice = DEBUG_BUILD && observation && !active ? `<p class="field-help">${state.debugSaveError ? esc(state.debugSaveError) : '调试版会在本机保留脱敏后的域名摘要 24 小时，供电脑通过 ADB 读取；不保存原始 DNS 日志。'}</p>` : '';
  const results = observation && !active && !state.observationError ? `<details id="observe-results" class="observe-results${state.aiOpen && (state.aiBusy || state.aiResults.length) ? ' hidden' : ''}" ${state.observationResultsOpen ? 'open' : ''}><summary class="observe-results-head"><b>观察结果</b><span class="tag">${fmt(state.observationDomains.length)} 个域名</span></summary><p class="field-help">${esc(observation.appLabel || '本次观察')} · 显示观察窗口内查到的域名，重复请求合并计数；以前出现过的域名再次查询也会显示。观察记录来自整台设备的 DNS，可能混入后台应用请求；缓存、应用自带 DoH/HTTPDNS 或绕过模块的 VPN 请求可能不可见。</p>${truncation}${debugNotice}<div id="observation-selection-tools">${observationSelectionTools()}</div><div id="observation-list" class="observe-list">${observationRows()}</div></details>` : '';
  return `<section class="panel"><div class="panel-head"><div><h2 class="section-title">域名观察</h2><p class="section-sub">选择本机应用，自动重新打开并观察开屏请求</p></div><div class="btn-row">${tag('仅本机处理')}<button class="btn" data-action="apps-refresh" ${state.busy || state.appsLoading ? 'disabled' : ''}>${state.appsLoading ? '读取中…' : '刷新应用'}</button></div></div><p class="field-help observe-help">输入应用名称或包名并选择匹配项。开始后会重新打开这个应用，结束后返回本页查看。这里只能记录经过 AdGuard Home 的 DNS 请求；结果不会自动上传，AI 分析需另行确认。</p><div class="observe-controls"><label class="observe-app-label">本机应用<input id="observe-app" class="field" maxlength="255" placeholder="例如：酷安" autocomplete="off" value="${esc(state.appQuery)}"></label><label class="observe-duration-label">观察时长<select id="observe-duration" class="field">${['5','10','15','30'].map(n => `<option value="${n}" ${state.observeDuration === n ? 'selected' : ''}>${n} 秒</option>`).join('')}</select></label><button class="btn btn-primary" data-action="observe-start" ${active || state.appsLoading || !state.selectedApp ? 'disabled' : ''}>${active ? '观察中…' : '开始并打开应用'}</button></div><div id="observe-app-results" class="app-results">${applicationResults()}</div>${status}${error}${results}<div id="ai-panel">${aiPanelMarkup()}</div></section>`;
}
function aiSettingsMarkup() {
  if (!state.aiSettingsOpen) return '';
  const c = state.aiConfig;
  const saved = c?.configured ? `<div class="notice ai-config-status" role="status"><span><b>当前配置已保存</b><br>接口：${esc(c.endpoint)}<br>模型：${esc(c.model)}<br>API 密钥：已保存（不回显）</span></div>` : '<div class="notice ai-config-status" role="status">尚未配置 AI 接口。</div>';
  const settings = state.aiSettingsOpen ? `<form id="ai-config-form" class="ai-form"><label>接口地址<input class="field" name="endpoint" type="url" required maxlength="2048" value="${esc(c?.endpoint || 'https://api.deepseek.com/chat/completions')}" placeholder="https://…/v1/chat/completions"></label><label>模型名称<input class="field" name="model" required maxlength="120" value="${esc(c?.model || 'deepseek-flash')}" placeholder="服务商提供的模型 ID"></label><label>API 密钥<input class="field" name="key" type="password" maxlength="4096" autocomplete="new-password" placeholder="${c?.configured ? '留空保留原密钥；换接口需重新填写' : '在本机填写，不要发到聊天或 GitHub'}"></label><p class="field-help">支持 OpenAI Chat Completions 兼容接口（需支持 JSON 输出），也可填写 OpenRouter、LiteLLM 或 New API 网关地址。密钥仅保存于本机 Root 私有目录。</p><div class="btn-row"><button class="btn btn-primary" ${state.aiBusy ? 'disabled' : ''}>保存配置</button><button class="btn" type="button" data-action="ai-deepseek" ${state.aiBusy ? 'disabled' : ''}>填入 DeepSeek 预设</button><button class="btn btn-danger" type="button" data-action="ai-clear" ${!c?.configured || state.aiBusy ? 'disabled' : ''}>删除密钥与配置</button></div></form>` : '';
  return `<section class="panel ai-settings"><div class="panel-head"><div><h2 class="section-title">AI 接口设置</h2><p class="section-sub">配置一次，在名单页分析选中的域名</p></div></div>${saved}${settings}<p class="field-help">密钥不会回显；留空保存时保留原密钥。保存后返回「名单 → 域名观察」操作。不会自动发送域名或调用付费接口。</p></section>`;
}
function renderAISettings() {
  pageFragments.delete('manage');
  const panel = $('#ai-settings-panel'); if (panel) panel.innerHTML = aiSettingsMarkup();
}
function revealAI(selector = '#ai-panel') {
  const panel = $(selector);
  panel?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}
function aiPanelMarkup() {
  if (!state.aiOpen) return '';
  const c = state.aiConfig;
  const selected = selectedAIResults();
  const total = state.aiResults.length, pages = Math.max(1, Math.ceil(total / 10));
  state.aiPage = Math.max(0, Math.min(state.aiPage, pages - 1));
  const labels = { ad: '疑似广告/跟踪', essential: '疑似正常服务', unknown: '无法判断' };
  const results = total ? `<p class="field-help">仅凭域名无法确定广告来源，默认不勾选。正常服务不提供批量拦截。</p><div class="observe-selection-head"><b>${selected.length} 个已选</b><button class="btn" data-action="ai-select-all" ${state.aiResults.some(r => r.verdict !== 'essential' && validObservedDomain(r.domain)) ? '' : 'disabled'}>全选可选项</button><button class="btn" data-action="ai-clear-selection" ${selected.length ? '' : 'disabled'}>取消全选</button></div><div class="ai-results">${state.aiResults.slice(state.aiPage * 10, state.aiPage * 10 + 10).map(r => `<label class="observe-row"><input type="checkbox" data-ai-domain="${esc(r.domain)}" aria-label="选择 ${esc(r.domain)}" ${r.verdict === 'essential' ? 'disabled' : ''} ${selected.includes(r.domain) ? 'checked' : ''}><span class="observe-copy"><strong>${esc(r.domain)}</strong><small>${esc(r.reason)}${domainInList(r.domain, state.lists.blacklist) ? ' · 已保存到个人名单' : ''}</small></span>${tag(labels[r.verdict], r.verdict === 'ad' ? 'yellow' : '')}</label>`).join('')}</div><nav class="logs-pagination" aria-label="AI 结果分页"><button class="btn" data-action="ai-page" data-page="${state.aiPage - 1}" ${state.aiPage === 0 ? 'disabled' : ''}>上一页</button><span>第 ${state.aiPage + 1} / ${pages} 页 · 共 ${total} 条</span><button class="btn" data-action="ai-page" data-page="${state.aiPage + 1}" ${state.aiPage >= pages - 1 ? 'disabled' : ''}>下一页</button></nav><div class="btn-row"><button class="btn" data-action="ai-import" ${selected.length ? '' : 'disabled'}>加入个人拦截（${selected.length}）</button><button class="btn" data-action="ai-submit" ${selected.length ? '' : 'disabled'}>提交共享候选</button></div>` : '';
  return `<div class="ai-panel" aria-live="polite"><div class="panel-head"><div><h3>AI 分析结果</h3><p class="section-sub">${state.aiBusy ? '正在分析所选域名…' : `本轮 ${total} 个域名 · 结果仅供核对`}</p></div><div class="btn-row"><button class="btn" data-action="ai-back-observation" ${state.aiBusy ? 'disabled' : ''}>返回观察结果</button><button class="btn" data-action="ai-settings" ${state.aiBusy ? 'disabled' : ''}>接口设置</button></div></div><p class="field-help" role="status">${state.aiBusy ? '后台任务运行中，可切换页面，返回后查看结果。' : '加入个人名单后自动应用，无需更新订阅；仍有广告需继续观察实际来源。'}</p>${state.aiError ? `<div class="notice warn" role="alert">${esc(state.aiError)}</div>` : ''}${results}</div>`;
}
function renderAI() {
  pageFragments.delete('lists');
  const tools = $('#observation-selection-tools'); if (tools) tools.innerHTML = observationSelectionTools();
  const panel = $('#ai-panel'); if (panel) panel.innerHTML = aiPanelMarkup();
  $('#observe-results')?.classList?.toggle('hidden', Boolean(state.aiOpen && (state.aiBusy || state.aiResults.length)));
  setBusy(state.busy);
}
function aiPayload(value) { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))); }
async function aiCall(action, ...args) {
  const r = await exec(`${JOB} ai-${action}${args.length ? ' ' + args.map(shellArg).join(' ') : ''}`);
  if (Number(r.errno)) throw new Error(textOf(r) || 'AI 操作失败，请检查接口设置');
  try { return JSON.parse(r.stdout); } catch { throw new Error('AI 组件返回格式无效，请升级模块'); }
}
let aiOpening = false;
async function openAI(settings = false) {
  if (state.aiBusy) { revealAI(); return; }
  if (aiOpening) return;
  aiOpening = true;
  try {
    state.aiConfig = await aiCall('status');
    if (settings || !state.aiConfig.configured) {
      state.aiSettingsOpen = true; pageFragments.delete('manage');
      if (state.page !== 'manage') navigate('manage'); else render(true);
      renderAISettings(); revealAI('#ai-settings-panel');
      if (!settings) toast('请先保存 AI 接口配置，再返回名单页分析');
      return;
    }
    requestAIAnalysis();
  } catch (e) {
    state.aiOpen = true; state.aiError = e.message; renderAI(); revealAI();
  } finally { aiOpening = false; }
}
function normalizeAIEndpoint(raw) {
  const u = new URL(String(raw).trim());
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('请填写不含账号或参数的 HTTPS 接口地址');
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname.endsWith('/chat/completions')) u.pathname += '/chat/completions';
  return u.href;
}
async function saveAIConfig(form) {
  const data = new FormData(form), key = form.querySelector('[name="key"]');
  const c = { endpoint: normalizeAIEndpoint(data.get('endpoint')), model: String(data.get('model') || '').trim(), key: String(data.get('key') || '').trim() };
  try { state.aiConfig = await aiCall('config', aiPayload(c)); state.aiError = ''; toast('AI 配置已保存；返回名单页分析所选域名'); }
  finally { if (key) key.value = ''; c.key = ''; }
  renderAISettings();
}
function selectedAIResults() {
  const allowed = new Set(state.aiResults.filter(r => r.verdict !== 'essential').map(r => r.domain));
  return [...new Set(state.aiSelected)].filter(d => allowed.has(d) && validObservedDomain(d));
}
function validateAIResult(j) {
  if (!Array.isArray(j.domains) || !j.domains.length || j.domains.length > 50 || j.domains.some(d => typeof d !== 'string' || !validObservedDomain(d)) || new Set(j.domains).size !== j.domains.length) throw new Error('AI 候选格式无效，未修改名单');
  if (!Array.isArray(j.results) || j.results.length !== j.domains.length || new Set(j.results.map(r => r.domain)).size !== j.domains.length || j.results.some(r => !j.domains.includes(r.domain) || !['ad','essential','unknown'].includes(r.verdict) || typeof r.reason !== 'string' || [...r.reason].length > 240)) throw new Error('AI 结果与候选不匹配，未修改名单');
  return j.results;
}
let aiMonitoring = false;
async function monitorAI(id) {
  if (aiMonitoring) return;
  aiMonitoring = true; state.aiBusy = true;
  try {
    for (let attempt = 0; attempt < 55; attempt++) {
      const j = await aiCall('poll', id);
      if (j.status === 'success') { state.aiResults = validateAIResult(j); state.aiSelected = []; state.aiPage = 0; state.aiError = ''; return; }
      if (j.status === 'failed') throw new Error(j.error || 'AI 分析失败，未修改名单');
      if (!['queued','running'].includes(j.status)) throw new Error('AI 任务状态无效');
      await sleep(2000);
    }
    throw new Error('AI 分析未完成，请稍后重新分析');
  } catch (e) { state.aiError = e.message; }
  finally { state.aiBusy = false; aiMonitoring = false; localStorage.removeItem(AI_PENDING_KEY); renderAI(); }
}
function requestAIAnalysis() {
  if (state.aiBusy) return;
  const domains = selectedObservationDomains(), c = state.aiConfig;
  if (domains.length > 50) { toast('AI 一次最多分析 50 个域名，请减少选择'); return; }
  if (!c?.configured || !domains.length) { toast('请配置接口并选择域名'); return; }
  // Freeze the consent snapshot before confirming an external request.
  const target = { domains, endpoint: c.endpoint, model: c.model };
  confirm('发送域名给 AI？', `将 ${domains.length} 个所选域名发送到 ${c.endpoint}，模型 ${c.model}。服务商会收到这些域名，可能产生 API 费用。不会发送完整日志，也不会自动修改名单。`, '确认并分析', async () => {
    if (state.aiBusy) return;
    const id = nextJobId(); state.aiOpen = true; state.aiBusy = true; state.aiError = ''; state.aiResults = []; state.aiSelected = []; renderAI(); revealAI();
    try { await aiCall('start', id, aiPayload(target)); localStorage.setItem(AI_PENDING_KEY, id); void monitorAI(id); }
    catch (e) { state.aiBusy = false; state.aiError = e.message; renderAI(); }
  });
}
async function importAIResults() {
  const domains = selectedAIResults(); if (!domains.length) return;
  await Promise.all([loadList('whitelist', true), loadList('blacklist', true)]);
  if (state.listErrors.whitelist || state.listErrors.blacklist) throw new Error('请先刷新本机名单，避免覆盖已有规则');
  const preview = preparePersonalImport({ blacklist: domains, whitelist: [] });
  const count = preview.lists.blacklist.length;
  if (!count) { toast('所选域名已存在或与放行名单重叠，未修改名单'); return; }
  confirm('加入个人拦截名单？', `合并导入 ${count} 个域名；保留已有名单并跳过放行项。AI 可能误判，请核对后操作。保存后自动应用个人名单，无需更新订阅。`, '合并导入', async () => {
    try { await importPersonalLists(preview.lists); state.aiSelected = []; renderAI(); } catch (e) { toast(e.message); }
  });
}

function logsPage() {
  const filters = [['all', '全部'], ['running', '进行中'], ['failure', '提醒'], ['success', '成功']];
  return `${heading('运行日志', '统一查看模块操作与环境诊断')}
    <section class="panel"><div class="panel-head"><div><h2 class="section-title">操作记录</h2><p class="section-sub">最近最多 120 条 · 每页 10 条 · 不保存 DNS 请求详情 · 导出到 Download/AdBlock Pro</p></div><div class="btn-row log-head-actions"><button class="btn" data-action="logs-refresh">刷新</button><button class="btn" data-action="logs-copy">复制日志</button><button class="btn" data-action="logs-export">导出</button></div></div><div class="log-tools"><input id="log-search" class="field" type="search" placeholder="搜索操作日志" value="${esc(state.logSearch)}"><div class="log-filters">${filters.map(([key, label]) => `<button class="log-filter ${state.logFilter === key ? 'selected' : ''}" data-filter="${key}">${label}</button>`).join('')}</div><button class="btn btn-danger" data-action="logs-clear">清空</button></div><div id="log-list" class="log-list">${logListMarkup()}</div></section>`;
}
function render(preservePageCache = false) {
  // Full state changes invalidate detached pages; ordinary navigation retains them.
  if (!preservePageCache) pageFragments.clear();
  const page = { home: homePage, rules: rulesPage, lists: personalRulesPage, manage: managePage, logs: logsPage }[state.page]();
  layout(page);
  syncStatusView();
  if (state.busy) setBusy(true);
  if (state.page === 'rules' && state.progress) drawProgress();
}


function setText(selector, value, root = document) {
  const el = $(selector, root);
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}
function updateChromeStatus() {
  if (!$('#app .app')) return;
  const sideState = state.error ? '状态读取失败' : state.status?.state === 'active' ? '防护已连接' : state.status?.state === 'paused' ? '服务已停止' : state.status?.state === 'bypassed' ? '系统接管已关闭' : '检查服务状态';
  const sideLabel = $('.side-footer strong');
  if (sideLabel) {
    const dot = $('.dot', sideLabel);
    if (dot) dot.className = 'dot ' + (!state.error && state.status?.state === 'active' ? 'on' : 'warn');
    if (sideLabel.lastChild?.nodeType === 3) sideLabel.lastChild.textContent = ' ' + sideState;
  }
  setText('.side-footer p', state.error ? '请通过支持 Root 接口的管理器或 WebUI 宿主打开本模块。' : '状态来自模块与 AdGuard Home 后端实时查询。');
  const tag = $('.top-actions .tag');
  if (tag) {
    const connected = Boolean(state.status) && !state.error;
    const label = state.error ? '连接异常' : connected ? '设备已连接' : '等待设备';
    tag.classList.toggle('green', connected);
    if (tag.textContent !== label) tag.textContent = label;
  }
}
function updateTag(el, value, good) {
  if (!el) return;
  if (el.textContent !== value) el.textContent = value;
  el.classList.toggle('green', good);
  el.classList.toggle('yellow', !good);
}
function syncStatusView() {
  updateChromeStatus();
  const s = state.status;
  if (state.page === 'home') {
    const [title, subtitle] = summaryText();
    setText('.hero-title', title);
    setText('.hero-sub', subtitle);
    const symbol = $('.hero-symbol');
    if (symbol) {
      const kind = s?.state === 'active' ? 'shield' : 'power';
      symbol.classList.toggle('off', kind !== 'shield');
      if (symbol.dataset.kind !== kind) { symbol.innerHTML = icon(kind); symbol.dataset.kind = kind; }
    }
    const pills = $$('.status-pills .mini-status');
    if (pills[0]) {
      const dot = $('.dot', pills[0]);
      if (dot) dot.className = 'dot ' + (coreRunning(s) ? 'on' : 'warn');
      if (pills[0].lastChild?.nodeType === 3) pills[0].lastChild.textContent = ' DNS ' + (coreRunning(s) ? '运行中' : s ? '已停止' : '待检查');
    }
    if (pills[1]) {
      const dot = $('.dot', pills[1]);
      if (dot) dot.className = 'dot ' + (s?.dns_redirect === '1' ? 'on' : 'warn');
      if (pills[1].lastChild?.nodeType === 3) pills[1].lastChild.textContent = ' DNS 重定向 ' + (s?.dns_redirect === '1' ? '已应用' : '未应用');
    }
    const filtering = $('[data-toggle="filtering"]');
    if (filtering && !state.busy && !filtering.disabled) filtering.checked = s?.filtering_enabled === 'true';
    const values = $$('.metrics .metric-value');
    const count = queryTotal(s?.dns_stats_json);
    const memory = memoryView(s);
    const valueTexts = [s ? fmt(s.blocked) : '—', count === null ? '—' : fmt(count), memory.value + ' MB'];
    values.forEach((el, index) => { if (index < valueTexts.length && el.textContent.trim() !== valueTexts[index]) {
      if (index === 2) el.innerHTML = memory.value + ' <span style="font-size:14px">MB</span>';
      else el.textContent = valueTexts[index];
    } });
    const metricFeet = $$('.metrics .metric-foot');
    if (metricFeet[2] && metricFeet[2].textContent !== memory.label) metricFeet[2].textContent = memory.label;
    const serviceRows = $$('#page-content [data-service-status] .rowitem');
    updateTag($('.tag', serviceRows[0]), coreRunning(s) ? '运行中' : s ? '已停止' : '未知', coreRunning(s));
    updateTag($('.tag', serviceRows[1]), s?.dns_redirect === '1' ? '重定向已应用' : s?.dns_takeover === 'off' ? '主动关闭' : '未重定向', s?.dns_redirect === '1');
    setText('#page-content .stack > .panel:last-child .panel-head .section-sub', s ? when(s.last_update) : '读取中');
  } else if (state.page === 'manage') {
    for (const [key, on] of [['takeover', s?.dns_takeover === 'on'], ['autostart', s?.autostart !== 'off'], ['auto-update', s?.auto_update !== 'off']]) {
      const input = $('[data-toggle="' + key + '"]');
      if (input && !state.busy && !input.disabled) input.checked = Boolean(s && on);
    }
  } else if (state.page === 'rules') {
    const select = $('#history-select');
    const history = (s?.history || []).join(',');
    if (select && select.dataset.history !== history && document.activeElement !== select) {
      const oldValue = select.value;
      select.innerHTML = '<option value="">选择历史版本</option>' + (s?.history || []).map(item => {
        const parts = item.split(':');
        const key = parts[0];
        return '<option value="' + esc(key) + '">' + esc(key.slice(0,4)+'-'+key.slice(4,6)+'-'+key.slice(6,8)+' '+key.slice(8,10)+':'+key.slice(10,12)) + ' · ' + fmt(parts[1]) + ' 条</option>';
      }).join('');
      if ([...select.options].some(option => option.value === oldValue)) select.value = oldValue;
      select.dataset.history = history;
    }
  }
}
function updateSourcesView() {
  if (state.page !== 'rules') return;
  const list = $('#source-list');
  if (list) {
    const signature = JSON.stringify([state.sourceError, state.sources, state.sourceRenameUrl, state.sourceEditUrl]);
    if (list.dataset.renderSignature !== signature) {
      list.innerHTML = sourceRows();
      list.dataset.renderSignature = signature;
    }
  }
  setText('[data-source-count]', state.sourceError ? (state.sourceError === '正在读取规则来源…' ? '加载中' : '设备未连接') : state.sources.filter(source => source.enabled === 'enabled').length + ' 个已启用');
  if (state.busy) setBusy(true);
}
function syncListsView() {
  if (state.page !== 'lists') return;
  for (const kind of ['blacklist', 'whitelist']) {
    const total = state.lists[kind].length;
    setText('[data-list-total="' + kind + '"]', fmt(total) + ' 条');
    renderListResults(kind);
  }
  const blocked = state.lists.blacklist.length, allowed = state.lists.whitelist.length;
  setText('.personal-summary .tag', fmt(blocked + allowed) + ' 条');
  const counts = $$('.personal-counts strong');
  if (counts[0]) counts[0].textContent = fmt(blocked);
  if (counts[1]) counts[1].textContent = fmt(allowed);
}

function parseStatus(text) {
  const fields = Object.fromEntries(text.split(/\r?\n/).map(line => { const i = line.indexOf('='); return i < 0 ? ['', ''] : [line.slice(0, i), line.slice(i + 1)]; }).filter(([key]) => key));
  const first = (fields.state || '').match(/^([^ ]+) blocked=(\d+) mode=(\S+)/);
  if (first) { fields.state = first[1]; fields.blocked = first[2]; fields.mode = first[3]; }
  fields.history = fields.history ? fields.history.split(',').filter(item => /^\d{14}-\d+:\d+$/.test(item)) : [];
  for (const key of ['dns_filter_json', 'dns_stats_json']) { try { fields[key] = JSON.parse(fields[key] || '{}'); } catch { fields[key] = null; } }
  return fields;
}

async function refreshStatus(silent = false, fresh = false) {
  if (statusPending && !fresh) return statusPending.promise;
  const requestId = ++statusRequestId;
  const promise = (async () => {
    try {
      const result = await exec(`${COMMAND} --status`);
      if (requestId !== statusRequestId) return;
      if (Number(result.errno) !== 0) throw new Error(textOf(result) || '读取状态失败');
      state.status = parseStatus(result.stdout || '');
      state.error = '';
      syncStatusView();
      if (!silent) toast('设备状态已刷新');
    } catch (error) {
      if (requestId !== statusRequestId) return;
      state.error = String(error.message || error);
      syncStatusView();
      if (!silent) toast('读取状态失败：' + (error.message || error));
    }
  })();
  statusPending = { requestId, promise };
  try { return await promise; }
  finally { if (statusPending?.requestId === requestId) statusPending = null; }
}
async function runConfig(action, ...values) {
  const id = nextJobId();
  const args = [action, ...values.map(shellArg)];
  if (!action.startsWith('list-')) args.push(id);
  const result = await exec(`${JOB} config ${args.join(' ')}`);
  if (Number(result.errno) !== 0) throw new Error(textOf(result) || '设置失败');
  return result;
}
function shellArg(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

let sourceRequestId = 0;
function invalidateSources() {
  sourceCache.clear(); sourceCacheTime.clear();
  ++sourceRequestId;
  sourcePending = null;
}
async function loadSources() {
  const key = 'all';
  const cached = sourceCache.get(key);
  if (cached && Date.now() - (sourceCacheTime.get(key) || 0) < SOURCE_CACHE_MS) {
    ++sourceRequestId;
    state.sources = [...cached];
    state.sourceError = '';
    sourcesDisplayed = true;
    updateSourcesView();
    return;
  }
  if (sourcePending?.requestId === sourceRequestId) {
    return sourcePending.promise;
  }
  const requestId = ++sourceRequestId;
  const keepVisible = sourcesDisplayed && state.sources.length > 0;
  if (cached) state.sources = [...cached];
  else if (!keepVisible) state.sources = [];
  state.sourceError = cached || keepVisible ? '' : '正在读取规则来源…';
  if (!keepVisible) updateSourcesView();

  const pending = (async () => {
    try {
      const result = await exec(`${JOB} config list-sources`);
      if (requestId !== sourceRequestId) return;
      if (Number(result.errno) !== 0) throw new Error(textOf(result) || '读取来源失败');
      const lines = (result.stdout || '').split(/\r?\n/).filter(Boolean);
      const sources = lines.map(line => line.split('\t')).filter(row => row[0] === 'source').map(row => ({ id: row[1], label: row[2], url: row[3], enabled: row[4], configured: row[5], removable: row[6] }));
      sourceCache.set(key, sources);
      sourceCacheTime.set(key, Date.now());
      state.sources = sources;
      state.sourceError = '';
      sourcesDisplayed = true;
    } catch (error) {
      if (requestId !== sourceRequestId) return;
      if (cached) state.sources = [...cached];
      state.sourceError = error.message || '无法连接设备后端';
    }
    updateSourcesView();
  })();
  sourcePending = { requestId, promise: pending };
  try { return await pending; }
  finally { if (sourcePending?.requestId === requestId) sourcePending = null; }
}

async function loadList(kind, force = false) {
  if (!Object.prototype.hasOwnProperty.call(listRequestIds, kind)) throw new Error('Unsupported list');
  if (!force && Date.now() - listCacheTime[kind] < LIST_CACHE_MS && !state.listErrors[kind]) return;
  const requestId = ++listRequestIds[kind];
  try {
    const result = await runConfig(`list-${kind}`);
    if (requestId !== listRequestIds[kind]) return;
    state.lists[kind] = [...new Set((result.stdout || '').split(/\r?\n/).map(x => x.trim().toLowerCase()).filter(x => x && !x.startsWith('#')))];
    listCacheTime[kind] = Date.now();
    delete state.listErrors[kind];
  } catch (error) {
    if (requestId !== listRequestIds[kind]) return;
    state.listErrors[kind] = error.message || '无法连接设备后端';
  }
  syncListsView();
}
let logsGeneration = 0;
let logsRequestGeneration = 0;
function loadLogs(force = false) {
  if (state.logsPromise) {
    if (logsRequestGeneration === logsGeneration) return state.logsPromise;
    // A task completed during the previous read. Wait, then coalesce callers
    // into one fresh query instead of accepting a pre-completion snapshot.
    return state.logsPromise.catch(() => {}).then(() => loadLogs(force));
  }
  if (!force && state.logsLoaded && Date.now() - state.logsLoadedAt < LOG_CACHE_MS) return Promise.resolve();
  const generation = logsGeneration;
  logsRequestGeneration = generation;
  state.logsPromise = (async () => {
    try {
      const result = await exec(`${JOB} recent`);
      if (generation !== logsGeneration) return;
      if (Number(result.errno) !== 0) throw new Error(textOf(result) || '读取日志失败');
      state.logs = (result.stdout || '').split(/\r?\n/).filter(Boolean);
      state.logsLoaded = true; state.logsLoadedAt = Date.now(); state.logPage = 0; state.logsError = '';
    } catch (error) {
      if (generation !== logsGeneration) return;
      state.logsError = error.message || '无法连接设备后端';
      if (!state.logsLoaded) state.logs = [];
      throw error;
    } finally {
      state.logsPromise = null;
      if (generation === logsGeneration && state.page === 'logs') renderLogList();
    }
  })();
  return state.logsPromise;
}
let logSearchFrame = 0;
const listSearchFrames = { whitelist: 0, blacklist: 0 };
function filterLogs() {
  state.logSearch = $('#log-search')?.value || '';
  state.logPage = 0;
  if (logSearchFrame) cancelAnimationFrame(logSearchFrame);
  logSearchFrame = requestAnimationFrame(() => {
    logSearchFrame = 0;
    if (state.page === 'logs') renderLogList();
  });
}
function filterLists(field) {
  const kind = field.dataset.searchList;
  if (!['whitelist', 'blacklist'].includes(kind)) return;
  state.listSearch[kind] = field.value;
  state.listPage[kind] = 0;
  if (listSearchFrames[kind]) cancelAnimationFrame(listSearchFrames[kind]);
  listSearchFrames[kind] = requestAnimationFrame(() => {
    listSearchFrames[kind] = 0;
    if (state.page === 'lists') renderListResults(kind);
  });
}
async function withButtonPending(button, action) {
  if (!button || button.dataset.uiPending === '1') return;
  button.dataset.uiPending = '1';
  button.disabled = true;
  try { return await action(); }
  finally {
    if (button.isConnected) {
      delete button.dataset.uiPending;
      if (!state.busy) button.disabled = false;
      else button.dataset.jobDisabled = '1';
    }
  }
}
function setBusy(busy) {
  state.busy = busy;
  const controls = $$('.btn, .choice, .source-actions button, [data-toggle], form input, form select, form button');
  for (const control of controls) {
    if (busy) {
      if (!control.disabled) {
        control.dataset.jobDisabled = '1';
        control.disabled = true;
      }
    } else if (control.dataset.jobDisabled === '1') {
      control.disabled = false;
      delete control.dataset.jobDisabled;
    }
  }
}
function drawProgress() {
  const card = $('#update-progress');
  if (!card || !state.progress) return;
  const { stage, elapsed, result } = state.progress;
  card.classList.remove('hidden', 'running', 'done', 'failed');
  card.classList.add(result);
  setText('#update-stage', stage);
  setText('#update-elapsed', elapsed);
}
function progress(stage, elapsed, result = 'running') {
  state.progress = { stage, elapsed, result };
  drawProgress();
}
async function monitorJob(id, action) {
  const start = Date.now();
  while (Date.now() - start < 10 * 60 * 1000) {
    const elapsed = Date.now() - start;
    await sleep(document.hidden ? 6000 : elapsed < 20000 ? 1500 : elapsed < 90000 ? 2500 : 4500);
    let result;
    try { result = await exec(`${JOB} poll ${id}`); } catch (error) { if (action === '--update') progress('读取进度遇到连接错误，后台任务可能仍在运行', '稍后可在日志中查看'); continue; }
    if (Number(result.errno) !== 0) {
      if (action === '--update') progress('暂时无法读取任务进度，正在重试', '后台任务仍可能运行');
      continue;
    }
    const body = result.stdout || '';
    if (action === '--observe') {
      const started = body.match(/OBSERVE_START_EPOCH=(\d+)/);
      if (started && state.observation) {
        state.observation.startedAt = Number(started[1]) * 1000;
        localStorage.setItem(OBSERVE_SESSION_KEY, JSON.stringify(state.observation));
      }
    }
    const done = body.match(/\nJOB_DONE=(\d+)\s*$/);
    if (done) {
      if (action !== '--observe') localStorage.removeItem('abp-pending-job');
      logsGeneration += 1;
      state.logsLoadedAt = 0;
      await Promise.allSettled([refreshStatus(true, true), loadLogs(true)]);
      const code = Number(done[1]);
      if (action === '--update' || action === '--sync-shared') {
        state.sharedLoaded = false;
        if (state.page === 'lists' && state.rulesView === 'shared') await loadSharedRules(true);
      }
      if (action === '--factory-reset' && code === 0) {
        invalidateSources();
        resetListView('blacklist'); resetListView('whitelist');
        await Promise.allSettled([loadSources(), loadList('blacklist', true), loadList('whitelist', true)]);
        state.sharedLoaded = false;
        state.sharedRules = []; state.sharedError = ''; state.aiConfig = null;
        state.aiResults = []; state.aiSelected = []; state.aiError = ''; state.aiOpen = false;
        state.observation = null; state.observationDomains = []; state.selectedObservationDomains = [];
        state.observationError = ''; state.observationResultsOpen = false;
        localStorage.removeItem(AI_PENDING_KEY); localStorage.removeItem(OBSERVE_SESSION_KEY);
      }
      if (action === '--observe') {
        if (code === 0) {
          try { await loadObservationResult(id); localStorage.removeItem('abp-pending-job'); }
          catch (error) { state.observationError = `${error.message} 结果会在设备上短暂保留，可重试读取。`; }
        } else {
          localStorage.removeItem('abp-pending-job');
          localStorage.removeItem(OBSERVE_SESSION_KEY);
          state.observation = null;
          const outputLines = body.split(/\r?\n/).filter(Boolean).filter(line => !line.startsWith('JOB_DONE='));
          state.observationError = outputLines.find(line => line.startsWith('[!]')) || outputLines.at(-1) || '观察失败，请查看运行日志。';
        }
      }
      if (action === '--update') progress(code === 0 ? '规则更新完成' : '更新失败，请查看日志', `耗时 ${Math.floor((Date.now() - start) / 1000)} 秒`, code === 0 ? 'done' : 'failed');
      if (action === '--apply-personal') {
        state.personalApplyError = code !== 0;
        state.personalApplyMessage = code === 0 ? (state.status?.filtering_enabled === 'false' ? '个人名单已应用；过滤当前关闭，开启过滤后生效。' : '个人名单已应用，未更新其他订阅。') : '名单已保存，但应用失败；可点“应用个人名单”重试，详情见运行日志。';
        pageFragments.delete('lists');
      }
      state.job = null; setBusy(false);
      syncStatusView();
      if (action === '--observe' || action === '--factory-reset' || (action === '--apply-personal' && state.page === 'lists') || (state.page === 'lists' && state.rulesView === 'shared')) render();
      toast(action === '--apply-personal' ? state.personalApplyMessage : action === '--observe' ? (code === 0 ? `观察完成，记录 ${fmt(state.observationDomains.length)} 个域名` : '域名观察失败') : action === '--factory-reset' ? (code === 0 ? '已恢复默认设置；备份位置见运行日志' : '恢复默认设置失败；请查看运行日志') : (code === 0 ? '操作已完成' : '操作失败，请查看运行日志'));
      return code;
    }
    if (action === '--update') {
      const stages = [...body.matchAll(/\[进度\]\s*([^\r\n]+)/g)];
      progress(stages.length ? stages.at(-1)[1] : '规则更新任务已启动', `已等待 ${Math.floor((Date.now() - start) / 1000)} 秒`);
    } else if (action === '--observe') {
      const progressNode = $('#observe-progress span');
      if (progressNode && state.observation) {
        const remaining = Math.max(0, Math.ceil((state.observation.startedAt + state.observation.duration * 1000 - Date.now()) / 1000));
        progressNode.textContent = `记录中 · 约 ${remaining} 秒后分析。${state.observation.appPackage ? '已打开' : '请打开'}${state.observation.appLabel || '目标应用'}并复现广告，然后返回此页。`;
      }
    }
  }
  setBusy(false); state.job = null;
  syncStatusView();
  if (action === '--update') progress('任务仍在后台运行；可到运行日志继续查看', '等待超时', 'failed');
  toast('等待超时，后台任务可能仍在运行；请查看日志，不要重复操作。');
}
async function startJob(action, argument = '', metadata = {}) {
  if (state.job || jobStarting) throw new Error('已有后台任务正在运行，请先等待当前操作完成');
  jobStarting = true;
  const id = nextJobId();
  let result;
  try { result = await exec(`${JOB} start ${id} ${action}${argument ? ` ${shellArg(argument)}` : ''}${action === '--observe' && metadata.appPackage ? ` ${shellArg(metadata.appPackage)}` : ''}`); }
  finally { jobStarting = false; }
  if (Number(result.errno) !== 0) throw new Error(textOf(result) || '无法启动后台任务');
  if (action === '--observe') {
    state.observation = { id, startedAt: Date.now(), duration: Number(argument), appLabel: String(metadata.appLabel || ''), appPackage: String(metadata.appPackage || ''), active: true };
    state.observationDomains = []; state.selectedObservationDomains = []; state.observationPage = 0; state.observationError = ''; state.observationTruncated = false; state.observationResultsOpen = false;
    localStorage.setItem(OBSERVE_SESSION_KEY, JSON.stringify(state.observation));
  }
  state.job = { id, action }; localStorage.setItem('abp-pending-job', `${id}:${action}`);
  setBusy(true);
  if (action === '--update') progress('任务已提交，等待下载进度', '正在启动');
  if (action === '--observe') render();
  void monitorJob(id, action);
}
async function startDiagnosis() {
  await startJob('--diagnose');
  toast('诊断已提交，可在运行日志查看结果');
}
function validObservedDomain(value) {
  return value.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}
function parseObservationSnapshot(raw, startedAt) {
  let snapshot = String(raw || ''), truncated = false;
  const meta = snapshot.match(/\n__ABP_META__truncated=(0|1)\s*$/);
  if (meta) { truncated = meta[1] === '1'; snapshot = snapshot.slice(0, meta.index); }
  const entries = snapshot.split(/\n__ABP_PAGE__\n/).flatMap(page => {
    const payload = JSON.parse(page);
    return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  });
  const domains = new Map();
  for (const entry of entries) {
    const time = Date.parse(entry?.time || '');
    if (!Number.isFinite(time) || time < startedAt) continue;
    const question = entry?.question;
    const domain = String(question?.name || question?.host || '').trim().toLowerCase().replace(/\.$/, '');
    if (!validObservedDomain(domain)) continue;
    const current = domains.get(domain) || { domain, count: 0, time: 0, reason: '', filterId: '' };
    current.count += 1; current.time = Math.max(current.time, time);
    if (/^Filtered/i.test(String(entry?.reason || ''))) current.reason = String(entry.reason);
    else if (!current.reason) current.reason = String(entry?.reason || '');
    if (entry?.filterId) current.filterId = String(entry.filterId);
    domains.set(domain, current);
  }
  return { domains: [...domains.values()].sort((a, b) => b.count - a.count || b.time - a.time), truncated };
}
function observationDebugText(domains, startedAt, sourceTruncated = false) {
  const validDomains = domains.filter(item => validObservedDomain(String(item?.domain || '')));
  const included = validDomains.slice(0, 200);
  const lines = [
    `captured_at\t${Math.floor(Date.now() / 1000)}`,
    `started_at\t${Math.floor(Number(startedAt) / 1000)}`,
    `domain_count\t${validDomains.length}`,
    `included_count\t${included.length}`,
    `source_truncated\t${sourceTruncated ? 1 : 0}`,
    'domain\trequests\tlast_seen\treason\tfilter_id',
  ];
  for (const item of included) {
    const count = Math.max(0, Math.floor(Number(item.count) || 0));
    const lastSeen = Math.max(0, Math.floor(Number(item.time) / 1000) || 0);
    const reason = /^[A-Za-z0-9_-]{0,64}$/.test(String(item.reason || '')) ? String(item.reason || '') : '';
    const filterId = /^[0-9]{1,12}$/.test(String(item.filterId || '')) ? String(item.filterId) : '';
    lines.push(`${item.domain}\t${count}\t${lastSeen}\t${reason}\t${filterId}`);
  }
  return `${lines.join('\n')}\n`;
}
async function saveObservationDebug(domains, startedAt, sourceTruncated = false) {
  if (!DEBUG_BUILD) return;
  const payload = observationDebugText(domains, startedAt, sourceTruncated);
  const encoded = btoa(payload);
  if (encoded.length > 100000) throw new Error('本次观察结果过大，未保存调试摘要');
  const result = await exec(`${JOB} debug-save ${shellArg(encoded)}`);
  if (Number(result.errno)) throw new Error(textOf(result) || '调试摘要保存失败');
}
async function loadObservationResult(id) {
  const result = await exec(`${JOB} observe-result ${id}`);
  if (Number(result.errno)) throw new Error(textOf(result) || '无法读取观察结果');
  const saved = state.observation || JSON.parse(localStorage.getItem(OBSERVE_SESSION_KEY) || '{}');
  if (!Number.isFinite(Number(saved.startedAt))) throw new Error('观察时间信息已丢失，请重新观察。');
  const snapshot = parseObservationSnapshot(result.stdout || '', Number(saved.startedAt));
  state.observationDomains = snapshot.domains;
  state.observationTruncated = snapshot.truncated;
  if (DEBUG_BUILD) {
    state.debugSaveError = '';
    try { await saveObservationDebug(state.observationDomains, saved.startedAt, state.observationTruncated); }
    catch { state.debugSaveError = '调试摘要保存失败；页面观察结果仍可正常查看。'; }
  }
  state.selectedObservationDomains = [];
  state.observationPage = 0;
  state.observationResultsOpen = false;
  state.observation = { ...saved, id, active: false };
  state.observationError = '';
  localStorage.removeItem(OBSERVE_SESSION_KEY);
  localStorage.removeItem('abp-pending-job');
  await exec(`${JOB} observe-clean ${id}`).catch(() => {});
}
async function startObservation() {
  if (state.aiBusy) throw new Error('请先等待当前 AI 分析结束');
  if (state.status?.state !== 'active') { toast('DNS 核心未运行，请先在总览确认服务状态'); return; }
  if (!state.selectedApp) { toast('请输入并选择匹配的本机应用'); return; }
  const duration = $('#observe-duration')?.value || '10';
  if (!['5','10','15','30'].includes(duration)) throw new Error('请选择有效观察时长');
  state.aiResults = []; state.aiSelected = []; state.aiError = ''; state.aiOpen = false;
  await startJob('--observe', duration, { appLabel: state.selectedApp.label, appPackage: state.selectedApp.packageName });
}
function confirm(title, message, yesLabel, onYes) {
  const modal = $('#modal');
  modal.innerHTML = `<section class="dialog" role="dialog" aria-modal="true"><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="dialog-actions"><button class="btn" data-modal="cancel">取消</button><button class="btn btn-primary" data-modal="yes">${esc(yesLabel)}</button></div></section>`;
  modal.hidden = false; modal.callback = onYes;
}

async function perform(action, argument = '') {
  try {
    if (state.busy) return;
    if (action === '--factory-reset' && state.aiBusy) throw new Error('请先等待 AI 分析结束，再恢复默认设置');
    if (action === '--update' && state.page !== 'rules') { state.page = 'rules'; render(); }
    await startJob(action, argument);
  } catch (error) { setBusy(false); syncStatusView(); toast(error.message || String(error)); }
}
async function exportLogs() {
  const rows = state.logs.map(line => { const [id, status, action, argument, summary] = line.split('\t'); return { time: new Date(Number(id)).toISOString(), status, action: actionNames[action] || action, argument, summary }; });
  const content = JSON.stringify(rows, null, 2);
  const path = await saveExportFile('operation-logs', content, 'AdBlock-Pro-operation-logs.json', 'application/json;charset=utf-8');
  if (path) toast(`日志已导出到：${path}`);
}
async function copyRecentLogs() {
  const result = await exec(`${JOB} recent-full`);
  if (Number(result.errno) !== 0) throw new Error(textOf(result) || '读取日志失败');
  await copyText(result.stdout || '');
  toast('最近任务日志已复制（含命令输出）');
}
async function exportObservedDomains() {
  const text = observationExportText();
  if (!text) throw new Error('请先选择要导出的域名');
  const path = await saveExportFile('observed-domains', text, 'AdBlock-Pro-observed-domains.txt', 'text/plain;charset=utf-8');
  return path;
}
async function exportPersonalRules() {
  if (window.ksu) {
    const result = await runConfig('export-rules', 'local');
    const path = String(result.stdout || '').match(/exported_path=([^\r\n]+)/)?.[1];
    if (!path) throw new Error('未能确认导出文件，请检查下载目录权限');
    toast(`已导出到：${path}`);
    return;
  }
  const lines = ['# AdBlock Pro 个人规则', `# 导出日期：${new Date().toISOString().slice(0, 10)}`, '', '[拦截名单]', ...(state.lists.blacklist || []), '', '[放行名单]', ...(state.lists.whitelist || [])];
  downloadBlob(lines.join('\n') + '\n', 'AdBlock-Pro-personal-rules.txt', 'text/plain;charset=utf-8');
}
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveExportFile(kind, content, fallbackName, mime) {
  if (!window.ksu) { downloadBlob(content, fallbackName, mime); return ''; }
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > 65536) throw new Error('导出文件不能超过 64 KB');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const payload = btoa(binary);
  const result = await exec(`${JOB} config export-file ${kind} ${nextExportId()} ${shellArg(payload)}`);
  if (Number(result.errno)) throw new Error(textOf(result) || '无法写入下载目录');
  const path = String(result.stdout || '').match(/exported_path=([^\r\n]+)/)?.[1];
  if (!path) throw new Error('未能确认导出文件，请检查下载目录权限');
  return path;
}

let sharedPending = null;
async function loadSharedRules(force = false) {
  if (!force && state.sharedLoaded) return;
  if (sharedPending) return sharedPending;
  sharedPending = (async () => {
    try {
      const result = await exec(`${JOB} config shared-rules`);
      if (Number(result.errno)) throw new Error(textOf(result) || '无法读取共享规则');
      const lines = String(result.stdout || '').split(/\r?\n/);
      state.sharedRules = [...new Set(lines.filter(x => x.startsWith('domain\t')).map(x => x.slice(7)).filter(validObservedDomain))];
      state.sharedRevision = lines.find(x => x.startsWith('revision='))?.slice(9) || '';
      state.sharedUpdatedAt = Number(lines.find(x => x.startsWith('updated_at='))?.slice(11)) || 0;
      state.sharedLoaded = true; state.sharedError = '';
    } catch (error) { state.sharedError = error.message; }
    if (state.page === 'lists' && state.rulesView === 'shared') render(true);
  })();
  try { await sharedPending; } finally { sharedPending = null; }
}

function parsePersonalImport(text) {
  if (new TextEncoder().encode(text).length > 65536) throw new Error('文件不能超过 64 KB，请拆分后导入');
  const result = { blacklist: [], whitelist: [] };
  const raw = text.replace(/^\uFEFF/, '').trim();
  if (raw.startsWith('{')) {
    let data; try { data = JSON.parse(raw); } catch { throw new Error('JSON 格式无效'); }
    if (!data || (data.format && data.format !== 'adblock-pro-personal-rules') || (data.version !== undefined && data.version !== 1) || (!Array.isArray(data.blacklist) && !Array.isArray(data.whitelist))) throw new Error('请使用个人名单 JSON 或导出的 TXT 文件');
    for (const kind of ['blacklist','whitelist']) {
      if (data[kind] !== undefined && !Array.isArray(data[kind])) throw new Error('名单字段必须是数组');
      result[kind] = data[kind] || [];
    }
  } else {
    let kind = 'blacklist';
    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || /^[#!]/.test(value)) continue;
      if (value === '[拦截名单]') { kind = 'blacklist'; continue; }
      if (value === '[放行名单]') { kind = 'whitelist'; continue; }
      if (/^@@\|\|[^\s]+\^$/.test(value)) result.whitelist.push(value.slice(4,-1));
      else if (/^\|\|[^\s]+\^$/.test(value)) result.blacklist.push(value.slice(2,-1));
      else result[kind].push(value);
    }
  }
  for (const kind of ['blacklist','whitelist']) {
    result[kind] = result[kind].map(value => {
      if (typeof value !== 'string') throw new Error('名单只能包含域名文本');
      const domain = value.trim().toLowerCase().replace(/\.$/, '');
      if (!validObservedDomain(domain)) throw new Error('名单包含无效域名，请检查文件后重试');
      return domain;
    });
    result[kind] = [...new Set(result[kind])];
  }
  if (result.blacklist.some(domain => result.whitelist.includes(domain))) throw new Error('同一域名不能同时加入拦截和放行名单');
  if (!result.blacklist.length && !result.whitelist.length) throw new Error('文件中没有可导入的域名');
  if (result.blacklist.length + result.whitelist.length > 5000) throw new Error('单次最多导入 5,000 条域名');
  return result;
}
function preparePersonalImport(lists) {
  const prepared = { blacklist: [], whitelist: [] };
  let skipped = 0;
  for (const kind of ['blacklist', 'whitelist']) {
    const opposite = kind === 'blacklist' ? 'whitelist' : 'blacklist';
    for (const domain of lists[kind]) {
      if (domainTouchesList(domain, state.lists[kind]) || domainTouchesList(domain, state.lists[opposite])) skipped++;
      else prepared[kind].push(domain);
    }
  }
  return { lists: prepared, skipped };
}
async function applyPersonalRules() {
  if (state.job || jobStarting) throw new Error('已有后台任务正在运行，请等待完成');
  setBusy(true);
  state.personalApplyMessage = '正在应用个人名单，无需下载订阅…';
  state.personalApplyError = false;
  try { await startJob('--apply-personal'); }
  catch (error) {
    setBusy(false);
    state.personalApplyError = true;
    state.personalApplyMessage = '名单已保存，但尚未应用；请稍后点“应用个人名单”重试。';
    throw new Error(`${state.personalApplyMessage} ${error.message}`);
  } finally { pageFragments.delete('lists'); if (state.page === 'lists') render(); }
}
async function savePersonalDomain(action, domain, kind) {
  setBusy(true);
  try { await runConfig(action, domain); resetListView(kind); await loadList(kind, true); }
  finally { setBusy(false); }
  await applyPersonalRules();
}
async function importPersonalLists(lists, message = '个人名单已合并保存') {
  if (state.busy) throw new Error('请先等待当前操作完成');
  setBusy(true);
  try {
  const wire = [...lists.blacklist.map(x => `B\t${x}`), ...lists.whitelist.map(x => `W\t${x}`)].join('\n') + '\n';
  if (wire.length > 65536) throw new Error('域名数据过大，请拆分后导入');
  await runConfig('import-lists', btoa(wire));
  await Promise.all([loadList('blacklist', true), loadList('whitelist', true)]);
  state.selectedObservationDomains = [];
  render(); toast(message);
  } finally { setBusy(false); }
  await applyPersonalRules();
}
async function importPersonalFile(file) {
  if (!file) return;
  if (file.size > 65536) throw new Error('文件不能超过 64 KB，请拆分后导入');
  const preview = preparePersonalImport(parsePersonalImport(await file.text()));
  const additions = preview.lists.blacklist.length + preview.lists.whitelist.length;
  if (!additions) throw new Error('没有新域名可导入；现有名单中的重复或冲突项已跳过');
  confirm('确认导入个人名单？', `预览：新增拦截 ${preview.lists.blacklist.length} 个、放行 ${preview.lists.whitelist.length} 个；跳过现有名单重复或冲突项 ${preview.skipped} 个。无效域名会在预览前拒绝。`, '确认导入', async () => {
    try { await importPersonalLists(preview.lists, `已导入 ${additions} 个个人规则`); }
    catch (error) { toast(error.message || '导入失败'); }
  });
}

let applicationsPending = null;
async function loadApplications(force = false) {
  if (applicationsPending) return applicationsPending;
  if (state.appsLoaded && !force) return;
  state.appsLoading = true; updateApplicationResults();
  applicationsPending = (async () => {
    try { state.apps = await listApplications(); state.appsLoaded = true; state.appsError = ''; }
    catch (error) { state.appsError = error.message || '无法读取应用，请检查宿主权限'; }
    finally { state.appsLoading = false; resolveApplication(); updateApplicationResults(); }
  })();
  try { await applicationsPending; } finally { applicationsPending = null; }
}
function matchingApplications() {
  const query = state.appQuery.trim().normalize('NFKC').toLowerCase();
  return query ? state.apps.filter(x => x.label.normalize('NFKC').toLowerCase().includes(query) || x.packageName.toLowerCase().includes(query)) : [];
}
function resolveApplication() {
  const matches = matchingApplications();
  const query = state.appQuery.trim().normalize('NFKC').toLowerCase();
  const exact = matches.filter(x => x.label.normalize('NFKC').toLowerCase() === query || x.packageName.toLowerCase() === query);
  state.selectedApp = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
}
function applicationResults() {
  if (!state.appQuery.trim()) return '<p class="field-help">输入名称匹配本机应用。旧宿主没有名称接口时，可输入应用包名。</p>';
  if (state.appsLoading) return '<p class="field-help" role="status">正在匹配本机应用…</p>';
  if (state.appsError) return `<p class="field-help">${esc(state.appsError)} <button class="btn" data-action="apps-retry">重试</button></p>`;
  const matches = matchingApplications();
  if (!matches.length) return '<p class="field-help">没有匹配应用。新安装的应用可点「刷新应用」，也可检查名称或输入完整包名。</p>';
  return matches.slice(0,8).map(app => `<button type="button" class="app-match ${state.selectedApp?.packageName === app.packageName ? 'selected' : ''}" data-action="app-select" data-package="${esc(app.packageName)}"><strong>${esc(app.label)}</strong><small>${esc(app.packageName)}</small></button>`).join('') + (matches.length > 8 ? '<p class="field-help">匹配项较多，请继续输入名称。</p>' : '');
}
function updateApplicationResults() {
  const node = $('#observe-app-results'); if (node) node.innerHTML = applicationResults();
  const button = $('[data-action="observe-start"]'); if (button) button.disabled = state.busy || state.appsLoading || !state.selectedApp;
  const refresh = $('[data-action="apps-refresh"]'); if (refresh) { refresh.disabled = state.busy || state.appsLoading; refresh.textContent = state.appsLoading ? '读取中…' : '刷新应用'; }
}

function copyGkdLink() {
  const field = document.createElement('textarea');
  field.value = 'https://github.com/gkd-kit/gkd';
  field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.appendChild(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('当前宿主无法复制链接，请在浏览器访问 github.com/gkd-kit/gkd');
  } finally { field.remove(); }
}

// Finish the first frame before calling the KernelSU native Shell bridge.
// An earlier tab's scheduled request cannot start after navigation changed.
function schedulePageLoad(page) {
  const epoch = ++navigationEpoch;
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (epoch !== navigationEpoch || state.page !== page) return;
      if (page === 'rules') void loadSources();
      else if (page === 'lists') { if (state.rulesView === 'shared') void loadSharedRules(); else void Promise.allSettled([loadList('whitelist'), loadList('blacklist')]); }
      else if (page === 'logs' && (!state.logsLoaded || Date.now() - state.logsLoadedAt >= LOG_CACHE_MS)) void loadLogs().catch(() => {});
    }, 0);
  });
}

function navigate(next) {
  if (!pages[next] || next === state.page) return;
  const host = $('#page-content');
  if (host) {
    // Preserve actual DOM and form state rather than reparsing page HTML.
    const fragment = document.createDocumentFragment();
    while (host.firstChild) fragment.appendChild(host.firstChild);
    pageFragments.set(state.page, fragment);
  }
  state.page = next;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const saved = host && pageFragments.get(next);
  if (saved) {
    host.appendChild(saved);
    pageFragments.delete(next);
    $$('[data-nav]').forEach(button => {
      const selected = button.dataset.nav === next;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    const breadcrumb = $('.breadcrumb b');
    if (breadcrumb) breadcrumb.textContent = pages[next];
    syncStatusView();
    if (next === 'lists') syncListsView();
    if (next === 'logs') renderLogList();
    if (next === 'rules') updateSourcesView();
    if (next === 'rules' && state.progress) drawProgress();
    setBusy(state.busy);
  } else {
    render(true);
    syncStatusView();
  }
  schedulePageLoad(next);
}

document.addEventListener('click', async event => {
  const navButton = event.target.closest('[data-nav]');
  if (navButton) { navigate(navButton.dataset.nav); return; }
  const modalButton = event.target.closest('[data-modal]');
  if (modalButton) { const modal = $('#modal'); const cb = modal.callback; const yes = modalButton.dataset.modal === 'yes'; modal.hidden = true; modal.innerHTML = ''; if (yes && cb) cb(); return; }
  const button = event.target.closest('[data-action], [data-filter]');
  if (!button || (state.busy && button.dataset.action !== 'theme' && !button.dataset.filter)) return;
  if (button.dataset.filter) { state.logFilter = button.dataset.filter; state.logPage = 0; $$('.log-filter').forEach(x => x.classList.toggle('selected', x === button)); renderLogList(); return; }
  switch (button.dataset.action) {
    case 'ai-open': void openAI(); break;
    case 'ai-settings': void openAI(true); break;
    case 'ai-view-results': state.aiOpen = true; renderAI(); revealAI(); break;
    case 'ai-back-observation': if (!state.aiBusy) { state.aiOpen = false; state.observationResultsOpen = true; const raw = $('#observe-results'); if (raw) raw.open = true; renderAI(); revealAI('#observe-results'); } break;
    case 'ai-settings-toggle': void openAI(true); break;
    case 'ai-deepseek': { const f = $('#ai-config-form'); if (f) { f.elements.endpoint.value = 'https://api.deepseek.com/chat/completions'; f.elements.model.value = 'deepseek-flash'; f.elements.key.value = ''; } break; }
    case 'ai-clear': confirm('删除 AI 配置？', '删除本机保存的接口密钥，不影响 DNS 或个人规则。', '删除配置', async () => { try { await aiCall('clear'); state.aiConfig = null; state.aiSettingsOpen = true; renderAISettings(); } catch (e) { toast(e.message); } }); break;
    case 'ai-analyze': requestAIAnalysis(); break;
    case 'ai-page': state.aiPage = Math.max(0, Number(button.dataset.page) || 0); renderAI(); break;
    case 'ai-select-all': state.aiSelected = [...new Set(state.aiResults.filter(r => r.verdict !== 'essential' && validObservedDomain(r.domain)).map(r => r.domain))]; renderAI(); break;
    case 'ai-clear-selection': state.aiSelected = []; renderAI(); break;
    case 'ai-import': importAIResults().catch(e => toast(e.message)); break;
    case 'ai-submit': { const domains = selectedAIResults(); if (domains.length) confirm('准备共享候选草稿？', '所选域名将写入 GitHub 草稿链接。请仅选择愿意公开的域名；需你手动提交，审核通过后才会进入共享规则。', '复制草稿链接', async () => { try { await copyText(communityIssueUrl(domains)); toast('草稿链接已复制，请在浏览器检查并手动提交'); } catch (e) { toast(e.message); } }); break; }
    case 'theme': state.theme = state.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('abp-theme', state.theme); document.documentElement.dataset.theme = state.theme; break;
    case 'personal-rules-export': exportPersonalRules().catch(e => toast(e.message)); break;
    case 'personal-rules-apply': try { await applyPersonalRules(); } catch (e) { toast(e.message); } break;
    case 'personal-rules-import': $('#personal-rules-file')?.click(); break;
    case 'shared-open': state.rulesView = 'shared'; pageFragments.delete('lists'); if (state.page !== 'lists') navigate('lists'); else render(true); void loadSharedRules(); break;
    case 'shared-back': state.rulesView = 'local'; render(true); break;
    case 'shared-sync': perform('--sync-shared'); break;
    case 'shared-source-add': {
      try { await runConfig('set-source', 'shared', 'on', 'balanced'); invalidateSources(); await loadSources(); toast('共享规则来源已加入；执行更新后生效'); }
      catch (e) { toast(e.message); }
      break;
    }
    case 'shared-submit-candidate': {
      if (!selectedObservationDomains().length) {
        state.rulesView = 'local'; state.observationResultsOpen = true; render(true); toast('请先在域名观察结果中选择候选域名'); break;
      }
      try { await copyText(communityIssueUrl()); toast('GitHub 候选草稿链接已复制；检查内容后手动提交，审核通过后才会进入共享规则'); }
      catch (e) { toast(e.message); }
      break;
    }
    case 'shared-page': state.sharedPage = Math.max(0, Number(button.dataset.page) || 0); renderSharedResults(); break;
    case 'app-select': {
      const app = state.apps.find(x => x.packageName === button.dataset.package);
      if (app) { state.selectedApp = app; state.appQuery = app.label; const field = $('#observe-app'); if (field) field.value = app.label; updateApplicationResults(); }
      break;
    }
    case 'apps-refresh':
    case 'apps-retry': void loadApplications(true); break;
    case 'copy-gkd-link': try { copyGkdLink(); toast('GKD 项目链接已复制'); } catch (e) { toast(e.message); } break;
    case 'diagnose': startDiagnosis().catch(e => toast(e.message)); break;
    case 'observe-start': startObservation().catch(e => toast(e.message)); break;
    case 'observe-retry': {
      if (!state.observation?.id) { toast('没有可读取的观察结果'); break; }
      try { await loadObservationResult(state.observation.id); render(); toast(`读取完成，记录 ${fmt(state.observationDomains.length)} 个域名`); }
      catch (e) { state.observationError = `${e.message} 结果会在设备上短暂保留，可重试读取。`; render(); }
      break;
    }
    case 'observe-select-all': state.selectedObservationDomains = [...new Set(state.observationDomains.map(item => item.domain).filter(validObservedDomain))]; renderObservationSelection(); break;
    case 'observe-select-visible': {
      const start = state.observationPage * OBSERVATION_PAGE_SIZE;
      const visible = state.observationDomains.slice(start, start + OBSERVATION_PAGE_SIZE).map(item => item.domain).filter(validObservedDomain);
      const selected = selectedObservationDomains();
      const allSelected = visible.length > 0 && visible.every(domain => selected.includes(domain));
      state.selectedObservationDomains = allSelected ? selected.filter(domain => !visible.includes(domain)) : [...new Set([...selected, ...visible])];
      renderObservationSelection();
      break;
    }
    case 'observe-clear-selection': state.selectedObservationDomains = []; renderObservationSelection(); break;
    case 'observe-copy-domains':
      try { await copyText(selectedObservationDomains().join('\n')); toast('已复制所选域名'); } catch (e) { toast(e.message); }
      break;
    case 'observe-export':
      try { const path = await exportObservedDomains(); toast(path ? `已导出到：${path}` : '已导出所选域名 TXT'); } catch (e) { toast(e.message); }
      break;
    case 'observe-copy-ai':
      try { await copyText(observationAIPrompt()); toast('已复制 AI 分析模板和所选域名'); } catch (e) { toast(e.message); }
      break;
    case 'observe-import-personal': {
      const chosen = selectedObservationDomains();
      const domains = chosen.filter(domain => !domainTouchesList(domain, state.lists.blacklist) && !domainTouchesList(domain, state.lists.whitelist));
      const skipped = chosen.length - domains.length;
      if (!domains.length) { toast('所选域名已存在于个人名单或与现有规则重叠，无需重复导入'); break; }
      confirm('加入个人拦截名单？', `预览：新增 ${domains.length} 个拦截域名，跳过现有黑白名单重复或重叠项 ${skipped} 个。加入后会拦截该域名及其子域名，保存后自动应用，无需更新订阅。`, '确认导入', async () => {
        try { await importPersonalLists({ blacklist: domains, whitelist: [] }, `已加入个人拦截名单，共 ${domains.length} 个域名`); }
        catch (error) { toast(error.message || '导入失败'); }
      });
      break;
    }
    case 'observe-add':
    case 'observe-allow': {
      const domain = button.dataset.domain;
      if (!validObservedDomain(domain)) { toast('域名格式无效'); break; }
      const kind = button.dataset.action === 'observe-allow' ? 'whitelist' : 'blacklist';
      const label = kind === 'whitelist' ? '放行' : '拦截';
      confirm(`加入个人${kind === 'whitelist' ? '白' : '黑'}名单？`, `加入后会${label} ${domain} 及其子域名。保存后自动应用个人名单，无需更新订阅。`, `确认${label}`, async () => {
        try { await savePersonalDomain(`add-${kind}`, domain, kind); }
        catch (error) { toast(error.message || '加入失败'); }
      });
      break;
    }
    case 'update': perform('--update'); break;
    case 'restart': confirm('重启 DNS 核心', '会重启本模块的 AdGuard Home 服务，可能短暂中断 DNS 解析。', '重启', () => perform('--restart')); break;
    case 'restore-defaults': confirm('恢复默认设置？', '这会按当前安装包恢复模块默认状态：清除自定义订阅和名称、个人黑白名单、AI 密钥、AdGuard Home 账号与设置（后台恢复为 admin/password）、规则缓存、共享同步状态、观察结果、日志和历史；过滤及自动运行恢复默认开启，DNS 接管恢复为 IPv4 默认开启，IPv6 仍关闭。执行前在 Download/AdBlock Pro 导出个人名单及基础偏好；含账号和密钥的完整备份仅保存在 /data/adb/adblockpro/backups，请勿分享。完成后会重启 DNS 核心。', '备份并恢复', () => perform('--factory-reset')); break;
    case 'disable-takeover': confirm('紧急解除 DNS 接管', '只会移除本模块创建的 DNS 重定向规则，AdGuard Home 服务会继续运行。', '解除接管', () => perform('--takeover', 'off')); break;
    case 'rollback': { const key = $('#history-select')?.value; if (!key) { toast('请先选择一个历史版本'); break; } confirm('恢复历史规则', '将替换当前规则来源和缓存。恢复后会重启 DNS 核心。', '恢复', () => perform('--rollback-history', key)); break; }
    case 'source-toggle': {
      const url = button.dataset.url; const next = button.dataset.enabled === 'enabled' ? 'off' : 'on';
      await withButtonPending(button, async () => {
        try { await runConfig('set-source', url, next); invalidateSources(); await loadSources(); toast(next === 'on' ? '规则来源已导入；更新后生效' : '规则来源已停用；更新后从过滤中移除'); } catch (e) { toast(e.message); }
      });
      break;
    }
    case 'source-delete': {
      const url = button.dataset.url; confirm('移除这条规则来源？', '移除后会从列表隐藏，下一次规则更新时生效。内置来源可重新添加，共享来源可在共享规则库中恢复。', '移除来源', async () => { try { await runConfig('remove-source', url); state.sourceRenameUrl = ''; state.sourceEditUrl = ''; invalidateSources(); await loadSources(); toast('规则来源已移除；当前规则将在更新后改变'); } catch (e) { toast(e.message); } }); break;
    }
    case 'source-rename-open': state.sourceRenameUrl = button.dataset.url; state.sourceEditUrl = ''; updateSourcesView(); break;
    case 'source-rename-cancel': state.sourceRenameUrl = ''; updateSourcesView(); break;
    case 'source-url-open': state.sourceEditUrl = button.dataset.url; state.sourceRenameUrl = ''; updateSourcesView(); break;
    case 'source-url-cancel': state.sourceEditUrl = ''; updateSourcesView(); break;
    case 'list-delete': { const kind = button.dataset.kind, domain = button.dataset.domain; try { await savePersonalDomain(`remove-${kind}`, domain, kind); } catch (e) { toast(e.message); } break; }
    case 'logs-refresh': loadLogs(true).then(() => toast('日志已刷新')).catch(e => toast(e.message)); break;
    case 'logs-copy': try { await copyRecentLogs(); } catch (e) { toast(e.message || '复制日志失败'); } break;
    case 'logs-clear': confirm('清空操作日志？', '只删除本模块的操作记录，不会影响规则历史或当前过滤配置。', '清空日志', async () => { try { const r = await exec(`${JOB} clear`); if (Number(r.errno)) throw new Error(textOf(r)); await loadLogs(true); toast('操作日志已清空'); } catch (e) { toast(e.message); } }); break;
    case 'logs-export': exportLogs().catch(e => toast(e.message || '日志导出失败')); break;
    case 'logs-page': state.logPage = Number(button.dataset.page); renderLogList(); break;
    case 'list-page': { const kind = button.dataset.kind; state.listPage[kind] = Math.max(0, Number(button.dataset.page) || 0); renderListResults(kind); break; }
    case 'observe-page': state.observationPage = Number(button.dataset.page); $('#observation-list').innerHTML = observationRows(); break;
  }
});


document.addEventListener('change', async event => {
  const input = event.target;
  if (input.matches('[data-ai-domain]')) {
    const domain = input.dataset.aiDomain;
    state.aiSelected = input.checked ? [...new Set([...selectedAIResults(), domain])] : selectedAIResults().filter(d => d !== domain);
    state.aiSelected = selectedAIResults(); renderAI(); return;
  }
  if (input.matches('[data-observation-domain]')) {
    const domain = input.dataset.observationDomain;
    const selected = selectedObservationDomains();
    state.selectedObservationDomains = input.checked ? [...new Set([...selected, domain])] : selected.filter(item => item !== domain);
    renderObservationSelection();
    return;
  }
  if (input.matches('#personal-rules-file')) {
    try { if (!state.busy) await importPersonalFile(input.files?.[0]); } catch (error) { toast(error.message); }
    finally { input.value = ''; }
    return;
  }
  if (input.matches('#observe-duration')) { state.observeDuration = input.value; return; }
  if (!input.matches('[data-toggle]') || state.busy) return;
  const key = input.dataset.toggle;
  const value = input.checked ? 'on' : 'off';
  input.disabled = true;
  try {
    input.closest('.switch')?.classList.add('is-pending');
    if (key === 'filtering') await startJob('--filtering', value);
    else if (key === 'takeover') await startJob('--takeover', value);
    else {
      await runConfig(key, value);
      await refreshStatus(true, true);
    }
    toast(key === 'filtering' || key === 'takeover' ? '操作已提交，完成状态会自动刷新' : '设置已保存');
  } catch (error) {
    await refreshStatus(true, true);
    toast(error.message || '设置失败');
  } finally {
    input.closest('.switch')?.classList.remove('is-pending');
    // A running background job owns this disabled input until setBusy(false).
    if (state.busy) input.dataset.jobDisabled = '1';
    else { input.disabled = false; syncStatusView(); }
  }
});

document.addEventListener('submit', async event => {
  if (state.busy) { event.preventDefault(); return; }
  const form = event.target;
  if (form.id === 'ai-config-form') {
    event.preventDefault(); if (!state.aiBusy) { try { await saveAIConfig(form); } catch (e) { toast(e.message); } }
  } else if (form.id === 'source-form') {
    event.preventDefault(); const data = new FormData(form); const name = data.get('name')?.toString().trim(); const url = data.get('url')?.toString().trim();
    try { await runConfig('add-source', url, name); invalidateSources(); await loadSources(); form.reset(); toast('规则来源已导入；更新后生效'); } catch (e) { toast(e.message); }
  } else if (form.matches('.source-rename-form')) {
    event.preventDefault(); const url = form.dataset.url; const name = new FormData(form).get('name')?.toString().trim();
    try { await runConfig('rename-source', url, name); state.sourceRenameUrl = ''; invalidateSources(); await loadSources(); toast('规则来源名称已保存'); } catch (e) { toast(e.message); }
  } else if (form.matches('.source-edit-form')) {
    event.preventDefault(); const oldUrl = form.dataset.url; const newUrl = new FormData(form).get('url')?.toString().trim();
    try { await runConfig('edit-source', oldUrl, newUrl); state.sourceEditUrl = ''; invalidateSources(); await loadSources(); toast('规则订阅链接已保存；执行规则更新后生效'); } catch (e) { toast(e.message); }
  } else if (form.matches('.domain-form')) {
    event.preventDefault(); const kind = form.dataset.kind, domain = new FormData(form).get('domain')?.toString().trim();
    try { await savePersonalDomain(`add-${kind}`, domain, kind); form.reset(); } catch (e) { toast(e.message); }
  } else if (form.id === 'domain-form') {
    event.preventDefault(); const domain = new FormData(form).get('domain')?.toString().trim(); const output = $('#domain-result'); output.textContent = '正在查询本地规则…';
    try { const result = await exec(`${COMMAND} --check-domain ${shellArg(domain)}`); if (Number(result.errno)) throw new Error(textOf(result)); output.textContent = textOf(result) || '查询完成'; } catch (e) { output.textContent = `检查失败：${e.message}`; }
  }
});
document.addEventListener('input', event => {
  if (event.target.matches('#log-search')) filterLogs();
  if (event.target.matches('.list-search')) filterLists(event.target);
  if (event.target.matches('#shared-search')) { state.sharedSearch = event.target.value; state.sharedPage = 0; renderSharedResults(); }
  if (event.target.matches('#observe-app')) { state.appQuery = event.target.value; resolveApplication(); updateApplicationResults(); void loadApplications(); }
});
document.addEventListener('toggle', async event => {
  const details = event.target;
  if (details.matches('#observe-results')) { state.observationResultsOpen = details.open; return; }
  if (!details.matches('.log-command-details') || !details.open || details.dataset.loaded === 'true' || details.dataset.loading === 'true') return;
  details.dataset.loading = 'true'; const output = $('.log-command-output', details); output.textContent = '正在读取命令输出…';
  try { const result = await exec(`${JOB} detail ${details.dataset.logId}`); if (Number(result.errno)) throw new Error(textOf(result)); output.textContent = result.stdout || '该操作没有额外输出'; details.dataset.loaded = 'true'; } catch (e) { output.textContent = `读取失败：${e.message}`; } finally { delete details.dataset.loading; }
}, true);

async function init() {
  render();
  const aiPending = localStorage.getItem(AI_PENDING_KEY);
  if (/^\d{1,20}$/.test(aiPending || '')) { state.aiOpen = true; void monitorAI(aiPending); }
  else localStorage.removeItem(AI_PENDING_KEY);
  await Promise.allSettled([refreshStatus(true), loadSources(), loadList('whitelist'), loadList('blacklist')]);
  syncStatusView();
  const pending = localStorage.getItem('abp-pending-job');
  if (pending) {
    const [id, action] = pending.split(':');
    if (/^\d{1,20}$/.test(id) && ['--update','--sync-shared','--apply-personal','--pause','--resume','--rollback','--rollback-history','--filtering','--takeover','--restart','--diagnose','--observe'].includes(action)) {
      if (action === '--observe') {
        try { state.observation = JSON.parse(localStorage.getItem(OBSERVE_SESSION_KEY) || 'null'); } catch { state.observation = null; }
        if (!state.observation || state.observation.id !== id) state.observation = { id, startedAt: Date.now(), duration: 60, appLabel: '', active: true };
      }
      state.job = { id, action }; if (action === '--update') state.page = 'rules'; render(); setBusy(true); void monitorJob(id, action);
    } else localStorage.removeItem('abp-pending-job');
  }
}
init();
setInterval(() => { if (!state.busy && !document.hidden) void refreshStatus(true); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden || state.busy) return;
  void refreshStatus(true);
  if (state.page === 'lists' && state.rulesView === 'local' && (state.appsLoaded || state.appQuery.trim())) void loadApplications(true);
});
