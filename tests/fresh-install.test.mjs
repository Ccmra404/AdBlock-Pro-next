import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function installFixture(t, family, preference, failWrite = false, failPermission = false) {
  const root = rootFixture(t); root.addBusybox(family);
  const state = path.join(root.dir, 'state'), runtime = path.join(root.dir, 'runtime');
  const module = path.join(root.dir, 'module'), stage = path.join(root.dir, 'stage');
  for (const dir of [state, module, stage]) mkdirSync(dir);
  if (preference !== undefined) writeFileSync(path.join(state, 'dns-takeover'), preference);
  const remap = text => text.replaceAll('/data/adb/adblockpro', shellPath(runtime))
    .replaceAll('/data/adb/bindhosts_personal', shellPath(state))
    .replaceAll('/data/adb/modules/AdGuardHome', shellPath(path.join(root.dir, 'absent')));
  const files = ['action.sh', 'module.prop', 'service.sh', 'uninstall.sh', 'bindhosts.sh', 'webui-config.sh', 'webui-job.sh',
    'settings.conf', 'config-blacklist.txt', 'config-whitelist.txt',
    'rules/shared-app-domains.txt', 'rules/source-registry.tsv', 'certs/cacert.pem',
    ...readdirSync(new URL('../scripts/', import.meta.url)).map(name => 'scripts/' + name),
    ...readdirSync(new URL('../webroot/', import.meta.url)).map(name => 'webroot/' + name)];
  for (const file of files) {
    const target = path.join(stage, file); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, remap(readFileSync(file === 'scripts/compat.sh' ? root.compatFile : new URL('../' + file, import.meta.url), 'utf8')));
  }
  mkdirSync(path.join(stage, 'bin/data/filters'), { recursive: true });
  writeFileSync(path.join(stage, 'bin/AdGuardHome'), 'fixture-only-engine');
  writeFileSync(path.join(stage, 'bin/curl'), '#!/bin/sh\necho "curl fixture"\n');
  for (const file of ['10007.txt', '1791638912.txt']) writeFileSync(path.join(stage, 'bin/data/filters', file), '||ads.cache.example^\n');
  writeFileSync(path.join(stage, 'bin/adblock-ai'), '#!/bin/sh\necho AI-fixture\n');
  writeFileSync(path.join(stage, 'bin/adblock-apps.dex'), 'application-label-fixture');
  const config = readFileSync(new URL('../tools/bootstrap/main.go', import.meta.url), 'utf8').match(/const initialConfig = `([\s\S]*?)`/)[1];
  // Fixture only: Linux ARM64 CI separately runs the real Go generator/core.
  writeFileSync(path.join(stage, 'bin/adblock-bootstrap'), '#!/bin/sh\ncat > "$1" <<\'ABP_CONFIG\'\n' + remap(config.replace('%s', 'fixture-only-hash')) + '\nABP_CONFIG\nprintf "fixture-only-credential\\n" > "$2"\n');
  const zip = path.join(root.dir, 'candidate.zip');
  const packed = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'from pathlib import Path\nimport sys,zipfile\np=Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for f in p.rglob("*"):\n  if f.is_file(): z.write(f,f.relative_to(p).as_posix())', stage, zip], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const script = path.join(root.dir, 'install.sh');
  writeFileSync(script, 'ui_print() { echo "$1"; }\nabort() { echo "$1" >&2; exit 1; }\ngetprop() { echo arm64-v8a; }\niptables() { return 0; }\nchown() { :; }\n' +
    (failPermission ? `chmod() { if [ "$1" = 700 ] && [ "$2" = '${shellPath(runtime)}/bin' ]; then return 1; fi; command chmod "$@"; }\n` : '') +
    (failWrite ? 'mv() { case "$2" in */dns-takeover) return 1;; esac; command mv "$@"; }\n' : '') + remap(readFileSync(new URL('../customize.sh', import.meta.url), 'utf8')));
  const install = () => spawnSync('bash', [shellPath(script)], { timeout: 20000, encoding: 'utf8', env: {
    ...root.env(family), MODPATH: shellPath(module), TMPDIR: shellPath(root.dir), ZIPFILE: shellPath(zip),
  } });
  return { state, runtime, module, install };
}

for (const family of ['KernelSU', 'Magisk', 'APatch']) {
  test(family + ': first install enables takeover without bundling device-specific personal rules', t => {
    const f = installFixture(t, family);
    const installed = f.install(); assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(f.runtime, 'bin')).mode & 0o777, 0o700);
    assert.equal(readFileSync(path.join(f.runtime, 'certs/cacert.pem'), 'utf8'), readFileSync(new URL('../certs/cacert.pem', import.meta.url), 'utf8'));
    assert.match(readFileSync(path.join(f.runtime, 'defaults/settings.conf'), 'utf8'), /enable_ipv6_dns=false/);
    assert.equal(existsSync(path.join(f.runtime, 'defaults/filters/10007.txt')), true);
    assert.equal(existsSync(path.join(f.runtime, 'bin/adblock-bootstrap')), true);
    assert.equal(readFileSync(path.join(f.runtime, 'bin/adblock-apps.dex'), 'utf8'), 'application-label-fixture');
    assert.equal(readFileSync(path.join(f.state, 'dns-takeover'), 'utf8'), 'on\n');
    assert.equal(readFileSync(path.join(f.state, 'vpn-compat'), 'utf8'), 'off\n');
    assert.match(installed.stdout, /DNS takeover: on \(initialized\)/);
    assert.match(readFileSync(path.join(f.runtime, 'bin/adblock-ai'), 'utf8'), /AI-fixture/);
    assert.equal(existsSync(path.join(f.runtime, 'scripts/source-registry.sh')), true);
    assert.equal(existsSync(path.join(f.module, 'rules/source-registry.tsv')), true);
    mkdirSync(path.join(f.state, 'ai'), { recursive: true });
    writeFileSync(path.join(f.state, 'ai/config.json'), 'fixture-private-config');
    const personal = path.join(f.runtime, 'bin/userfilters/adblock-pro-user-rules.txt');
    const defaults = readFileSync(new URL('../config-blacklist.txt', import.meta.url), 'utf8').split('\n').filter(row => row && !row.startsWith('#'));
    const rules = readFileSync(personal, 'utf8').split('\n').filter(row => row.startsWith('||'));
    assert.equal(rules.length, defaults.length);
    assert.deepEqual(defaults, []);
    const shared = readFileSync(path.join(f.runtime, 'bin/userfilters/adblock-pro-shared-app-rules.txt'), 'utf8');
    const expectedShared = readFileSync(new URL('../rules/shared-app-domains.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(row => row && !row.startsWith('#')).map(domain => '||' + domain + '^').sort();
    assert.deepEqual(shared.trim().split('\n').sort(), expectedShared);
    assert.match(shared, /\|\|adsmind\.ugdtimg\.com\^/);
    assert.deepEqual(rules, [...new Set(defaults.map(domain => '||' + domain + '^'))].sort());
    assert.match(readFileSync(path.join(f.runtime, 'bin/AdGuardHome.yaml'), 'utf8'), new RegExp('url: ' + shellPath(personal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(readFileSync(path.join(f.state, 'user-filter-applied'), 'utf8').trim(), shellPath(personal));
    // Reinstall must neither re-add a deleted default nor overwrite a whitelist.
    writeFileSync(path.join(f.state, 'blacklist.txt'), 'custom.personal.example\ncustom.personal.example\n');
    writeFileSync(path.join(f.state, 'whitelist.txt'), 'login.personal.example\n');
    writeFileSync(path.join(f.state, 'dns-takeover'), 'off\n');
    writeFileSync(path.join(f.state, 'vpn-compat'), 'on\n');
    const yaml = path.join(f.runtime, 'bin/AdGuardHome.yaml');
    const customDns = readFileSync(yaml, 'utf8')
      .replace('use_private_ptr_resolvers: false', 'use_private_ptr_resolvers: true')
      .replace('local_ptr_upstreams: []', 'local_ptr_upstreams:\n    - 192.0.2.53')
      .replace('    rdns: false', '    rdns: true');
    assert.match(customDns, /use_private_ptr_resolvers: true/);
    assert.match(customDns, /local_ptr_upstreams:\n    - 192\.0\.2\.53/);
    assert.match(customDns, /    rdns: true/);
    writeFileSync(yaml, customDns);
    chmodSync(path.join(f.runtime, 'bin'), 0o755);
    const again = f.install(); assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.equal(readFileSync(yaml, 'utf8'), customDns, 'upgrade replaced custom reverse DNS settings');
    if (process.platform !== 'win32') assert.equal(statSync(path.join(f.runtime, 'bin')).mode & 0o777, 0o700);
    assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), 'custom.personal.example\ncustom.personal.example\n');
    assert.equal(readFileSync(path.join(f.runtime, 'bin/userfilters/adblock-pro-shared-app-rules.txt'), 'utf8'), shared);
    assert.equal(readFileSync(path.join(f.state, 'dns-takeover'), 'utf8'), 'off\n');
    assert.equal(readFileSync(path.join(f.state, 'vpn-compat'), 'utf8'), 'on\n');
    assert.equal(readFileSync(path.join(f.state, 'ai/config.json'), 'utf8'), 'fixture-private-config');
    assert.match(again.stdout, /DNS takeover: off \(preserved\)/);
    assert.equal(readFileSync(personal, 'utf8').split('||custom.personal.example^').length, 2);
    assert.match(readFileSync(personal, 'utf8'), /@@\|\|login.personal.example\^/);
  });
}

test('a retained off preference is not overwritten even without an existing DNS installation', t => {
  const f = installFixture(t, 'Magisk', 'off\n');
  const result = f.install(); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.state, 'dns-takeover'), 'utf8'), 'off\n');
});

test('invalid persisted takeover state is retained and installation fails explicitly', t => {
  const f = installFixture(t, 'Magisk', '');
  const result = f.install(); assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Invalid saved dns-takeover/);
  assert.equal(readFileSync(path.join(f.state, 'dns-takeover'), 'utf8'), '');
});

test('failed preference persistence stops installation instead of claiming a working default', t => {
  const f = installFixture(t, 'Magisk', undefined, true);
  const result = f.install(); assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Cannot initialize dns-takeover/);
});

test('failed DNS working directory protection stops installation explicitly', t => {
  const f = installFixture(t, 'Magisk', undefined, false, true);
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Cannot protect local DNS working directory/);
});
