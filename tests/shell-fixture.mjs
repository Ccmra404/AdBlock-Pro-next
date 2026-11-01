import { readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const shellPath = value => process.platform === 'win32'
  ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
  : value;

export function rootFixture(t, incomplete = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {
    KernelSU: path.join(dir, 'ksu/bin/busybox'),
    Magisk: path.join(dir, 'magisk/busybox'),
    APatch: path.join(dir, 'ap/bin/busybox'),
  };
  let compat = readFileSync(new URL('../scripts/compat.sh', import.meta.url), 'utf8');
  compat = compat.replace('$(command -v busybox 2>/dev/null)', '');
  compat = compat.replaceAll('/data/adb/bindhosts_personal/root-family', shellPath(path.join(dir, 'root-family')));
  for (const [prefix, local] of [
    ['/data/adb/ksu', path.join(dir, 'ksu')],
    ['/data/adb/magisk', path.join(dir, 'magisk')],
    ['/data/adb/ap', path.join(dir, 'ap')],
  ]) compat = compat.replaceAll(prefix, shellPath(local));
  const compatFile = path.join(dir, 'scripts/compat.sh');
  mkdirSync(path.dirname(compatFile), { recursive: true });
  writeFileSync(compatFile, compat);

  function addBusybox(family) {
    const file = paths[family];
    mkdirSync(path.dirname(file), { recursive: true });
    const applets = ['sh', 'awk', 'flock', 'nohup', 'setuidgid', 'inotifyd'].filter(x => x !== incomplete);
    // Tool-selection fixture; it does not emulate Android privileges or locking.
    writeFileSync(file, `#!/bin/sh
if [ "$1" = --list ]; then printf '%s\\n' ${applets.join(' ')}; exit 0; fi
case "$1" in
  flock) shift; [ "$1" != -n ] || shift; shift; exec "$@" ;;
  sh) shift; exec bash "$@" ;;
  *) exec "$@" ;;
esac
`);
    chmodSync(file, 0o755);
  }
  function env(family = '') {
    return { ...process.env, BB: '', KSU: family === 'KernelSU' ? 'true' : '',
      APATCH: family === 'APatch' ? 'true' : '', MAGISK_VER_CODE: family === 'Magisk' ? '30000' : '' };
  }
  return { dir, paths, compatFile, addBusybox, env };
}

export function filteringBootstrap(root) {
  const js = path.join(root.dir, 'fake-adblock-bootstrap.js');
  const shim = path.join(root.dir, 'fake-adblock-bootstrap');
  writeFileSync(js, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
function fail(message, code = 1) { console.error(message); process.exit(code); }
function status() {
  let value;
  try { value = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { fail('invalid filter status'); }
  if (value?.filters === null) value.filters = [];
  if (value?.whitelist_filters === null) value.whitelist_filters = [];
  if (!Array.isArray(value.filters) || !Array.isArray(value.whitelist_filters)) fail('missing filter arrays');
  for (const entry of [...value.filters, ...value.whitelist_filters]) {
    if (typeof entry.url !== 'string' || !entry.url || typeof entry.name !== 'string' || !entry.name || typeof entry.enabled !== 'boolean') fail('invalid filter entry');
  }
  return value;
}
function list(value, kind) {
  if (kind === 'block') return value.filters;
  if (kind === 'allow') return value.whitelist_filters;
  fail('invalid filter list');
}
function find(value, url, kind) {
  const matches = list(value, kind).filter(entry => entry.url === url);
  if (matches.length !== 1) fail('filter not found or duplicated', 3);
  return matches[0];
}
const json = value => process.stdout.write(JSON.stringify(value));
switch (command) {
  case 'filtering-check-status': status(); break;
  case 'filtering-enabled-count': {
    const value = status();
    process.stdout.write(String([...value.filters, ...value.whitelist_filters].filter(entry => entry.enabled).length));
    break;
  }
  case 'filtering-is-enabled': {
    const [url, kind] = args;
    process.stdout.write(String(find(status(), url, kind).enabled));
    break;
  }
  case 'filtering-set-body': {
    const [url, kind, field, next] = args;
    const entry = find(status(), url, kind);
    const data = { name: entry.name, url: entry.url, enabled: entry.enabled };
    if (field === 'enabled' && (next === 'true' || next === 'false')) data.enabled = next === 'true';
    else if (field === 'name' && next) data.name = next;
    else if (field === 'url' && next) data.url = next;
    else if (field !== 'refresh') fail('invalid set field');
    json({ url: entry.url, whitelist: kind === 'allow', data });
    break;
  }
  case 'filtering-copy-body':
  case 'filtering-add-body': {
    const [source, target, kind] = args;
    const entry = find(status(), source, kind);
    if (command === 'filtering-copy-body') json({ url: target, whitelist: kind === 'allow', data: { name: entry.name, url: target, enabled: entry.enabled } });
    else json({ name: entry.name, url: target, whitelist: kind === 'allow' });
    break;
  }
  case 'filtering-new-body': {
    const [name, url, kind] = args;
    json({ name, url, whitelist: kind === 'allow' });
    break;
  }
  case 'filtering-remove-body': {
    const [url, kind] = args;
    json({ url, whitelist: kind === 'allow' });
    break;
  }
  default: fail('unknown filtering helper command');
}
`);
  chmodSync(js, 0o755);
  writeFileSync(shim, `#!/bin/sh\nexec "${shellPath(process.execPath)}" "${shellPath(js)}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shellPath(shim);
}
