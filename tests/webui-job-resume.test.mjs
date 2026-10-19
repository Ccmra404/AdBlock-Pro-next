import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8');
const init = source.slice(source.indexOf('async function init() {'), source.indexOf('\ninit();'));
for (const action of ['--factory-reset', '--update', '--invalid']) {
  test(`WebUI reopens with pending ${action}`, async () => {
    const storage = new Map([['abp-pending-job', '123:' + action]]);
    const polls = [], state = {};
    const context = vm.createContext({
      state, AI_PENDING_KEY:'ai-pending', OBSERVE_SESSION_KEY:'observation',
      localStorage:{getItem:k => storage.get(k), removeItem:k => storage.delete(k)},
      render() {}, syncStatusView() {}, refreshStatus() {}, loadSources() {}, loadList() {}, monitorAI() {},
      setBusy(value) {state.busy = value;}, monitorJob(...args) {polls.push(args);},
    });
    await vm.runInContext(init + '\ninit()', context);
    if (action === '--invalid') {
      assert.equal(polls.length, 0);
      assert.equal(storage.has('abp-pending-job'), false);
    } else {
      assert.equal(state.busy, true);
      assert.equal(state.job.action, action);
      assert.deepEqual(polls, [['123', action]]);
      assert.equal(storage.has('abp-pending-job'), true);
    }
  });
}
