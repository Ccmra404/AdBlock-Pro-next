import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../webroot/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/, '').replace(/\ninit\(\);[\s\S]*$/, '\n');

function setup(copyAllowed = true) {
  const field = { style: {}, select() { this.selected = true; }, remove() { this.removed = true; } };
  const commands = [];
  const context = vm.createContext({
    document: {
      documentElement: {}, body: { appendChild() {} },
      querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
      createElement(type) { assert.equal(type, 'textarea'); return field; },
      execCommand(command) { assert.equal(command, 'copy'); return copyAllowed; },
    },
    window: {}, localStorage: { getItem() { return null; } },
    exec(command) { commands.push(command); throw new Error('No shell request expected'); },
  });
  vm.runInContext(source, context);
  return { context, field, commands };
}

test('GKD entry does not navigate the WebView or open another activity', () => {
  const h = setup();
  const html = vm.runInContext('managePage()', h.context);
  assert.match(html, /data-action="copy-gkd-link"/);
  assert.doesNotMatch(html, /href="https:\/\/github.com\/gkd-kit\/gkd"/);
  vm.runInContext('copyGkdLink()', h.context);
  assert.equal(h.field.value, 'https://github.com/gkd-kit/gkd');
  assert.equal(h.field.selected, true);
  assert.equal(h.field.removed, true);
  assert.equal(h.commands.length, 0);
});

test('unsupported clipboard reports a useful error and removes the temporary field', () => {
  const h = setup(false);
  assert.throws(() => vm.runInContext('copyGkdLink()', h.context), /github.com\/gkd-kit\/gkd/);
  assert.equal(h.field.removed, true);
  assert.equal(h.commands.length, 0);
});
