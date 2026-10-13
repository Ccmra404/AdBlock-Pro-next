import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/, '')
  .replace(/\ninit\(\);[\s\S]*$/, '\n');

class Fragment {
  constructor() { this.children = []; this.parent = null; }
  get firstChild() { return this.children[0] || null; }
  appendChild(node) {
    if (node instanceof Fragment) {
      while (node.firstChild) this.appendChild(node.firstChild);
      return node;
    }
    if (node.parent) {
      const list = node.parent.children;
      list.splice(list.indexOf(node), 1);
    }
    this.children.push(node);
    node.parent = this;
    return node;
  }
}

function setup() {
  const pending = [], frames = [], timers = [];
  const host = new Fragment();
  const document = {
    documentElement: {}, body: {},
    querySelector(selector) { return selector === '#page-content' ? host : null; },
    querySelectorAll() { return []; },
    createDocumentFragment() { return new Fragment(); },
    addEventListener() {},
  };
  const context = vm.createContext({
    document, window: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    setInterval() {},
    exec(command) { return new Promise(resolve => pending.push({ command, resolve })); },
  });
  vm.runInContext(source, context);
  const state = vm.runInContext('state', context);
  return {
    host, context, state, pending, frames, timers,
    go(page) { context.nextPage = page; vm.runInContext('navigate(nextPage)', context); },
    flushScheduled() {
      while (frames.length) frames.shift()();
      while (timers.length) timers.shift()();
    },
    setCached(page, fragment) {
      context.fixtureFragment = fragment;
      context.fixturePage = page;
      vm.runInContext('pageFragments.set(fixturePage, fixtureFragment)', context);
    },
  };
}

test('returning to rules restores original DOM instead of rebuilding it', () => {
  const h = setup();
  h.state.page = 'lists';
  const listNode = { name: 'lists' };
  const ruleNode = { name: 'rules', userInput: 'not lost' };
  const ruleFragment = new Fragment();
  ruleFragment.appendChild(ruleNode);
  h.host.appendChild(listNode);
  h.setCached('rules', ruleFragment);

  h.go('rules');
  assert.equal(h.host.firstChild, ruleNode);
  assert.equal(h.host.firstChild.userInput, 'not lost');
  assert.equal(h.state.page, 'rules');
  h.go('lists');
  assert.equal(h.host.firstChild, listNode);
  h.go('rules');
  assert.equal(h.host.firstChild, ruleNode, 'DOM identity and form state are retained');
});

test('navigation does not call KernelSU before the first rendered frame', () => {
  const h = setup();
  h.state.page = 'lists';
  h.host.appendChild({ name: 'lists' });
  const rules = new Fragment();
  rules.appendChild({ name: 'rules' });
  h.setCached('rules', rules);
  h.go('rules');
  assert.equal(h.pending.length, 0);
  assert.equal(h.frames.length, 1);
  h.frames.shift()();
  assert.equal(h.pending.length, 0);
  h.timers.shift()();
  assert.equal(h.pending.length, 1);
  assert.match(h.pending[0].command, /config list-sources balanced/);
});

test('rapid navigation cancels the previous tab native load', () => {
  const h = setup();
  h.state.page = 'lists';
  h.host.appendChild({ name: 'lists' });
  const rules = new Fragment();
  rules.appendChild({ name: 'rules' });
  h.setCached('rules', rules);
  h.go('rules');
  h.go('lists');
  h.flushScheduled();
  assert.equal(h.pending.filter(x => x.command.includes('list-sources')).length, 0);
});


test('cached logs paint data fetched in the background even before TTL expires', () => {
  const h = setup();
  h.state.page = 'home';
  const cached = new Fragment(); cached.appendChild({ name: 'logs' });
  h.setCached('logs', cached);
  vm.runInContext('let logPaints = 0; renderLogList = () => { logPaints++; };', h.context);
  h.state.logsLoaded = true; h.state.logsLoadedAt = Date.now();
  h.state.logs = ['new background entry'];
  h.go('logs');
  assert.equal(vm.runInContext('logPaints', h.context), 1);
  h.flushScheduled();
  assert.equal(h.pending.length, 0, 'cache repaint does not require another native request');
});

test('full state changes invalidate detached pages but navigation retains them', () => {
  const h = setup();
  h.setCached('rules', new Fragment());
  vm.runInContext('layout = () => {}; render(true);', h.context);
  assert.equal(vm.runInContext('pageFragments.size', h.context), 1);
  vm.runInContext('render();', h.context);
  assert.equal(vm.runInContext('pageFragments.size', h.context), 0);
});
