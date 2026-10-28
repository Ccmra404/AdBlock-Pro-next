import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

for (const family of ['KernelSU', 'Magisk', 'APatch']) {
  test(family + ': rc.3 upgrade preserves credentials, cache, lists, profiles and history', t => {
    const root = rootFixture(t); root.addBusybox(family);
    const state = path.join(root.dir, 'state'), runtime = path.join(root.dir, 'runtime');
    const module = path.join(root.dir, 'module'), stage = path.join(root.dir, 'stage');
    const paths = [state, module, stage, path.join(state, 'profiles'), path.join(state, 'dns-history'),
      path.join(runtime, 'bin/data/filters')];
    for (const directory of paths) mkdirSync(directory, { recursive: true });
    const privateFiles = new Map([
      [path.join(runtime, 'admin.auth'), 'admin:fixture-only-existing-secret\n'],
      [path.join(runtime, 'bin/AdGuardHome.yaml'), 'native_rules: keep\nfiltering:\n  safe_fs_patterns:\n    - ' + shellPath(runtime) + '/bin/userfilters/*\n'],
      [path.join(runtime, 'settings.conf'), 'enable_ipv6_dns=false\nblock_ipv6_dns=false\n'],
      [path.join(runtime, 'bin/data/filters/10007.txt'), 'existing-cache-10007\n'],
      [path.join(runtime, 'bin/data/filters/1791638912.txt'), 'existing-cache-awa\n'],
      [path.join(state, 'blacklist.txt'), 'ads.personal.example\n'],
      [path.join(state, 'whitelist.txt'), 'login.personal.example\n'],
      [path.join(state, 'profiles/balanced.txt'), 'https://example.org/personal.txt\n'],
      [path.join(state, 'profiles/light.txt'), '\n'],
      [path.join(state, 'profiles/strict.txt'), '\n'],
      [path.join(state, 'dns-history/previous.tar.gz'), 'keep-history\n'],
      [path.join(state, 'custom-sources.txt'), 'https://example.org/personal.txt\n'],
      [path.join(state, 'sources-applied.txt'), 'https://example.org/personal.txt\n'],
      [path.join(state, 'blocking-mode'), 'balanced\n'],
      [path.join(state, 'auto-update'), 'off\n'],
      [path.join(state, 'autostart'), 'off\n'],
      [path.join(state, 'dns-takeover'), 'off\n'],
      [path.join(state, 'app-exclusions.txt'), '0:com.example.excluded\n'],
    ]);
    for (const [file, content] of privateFiles) writeFileSync(file, content);
    for (const marker of ['v3-installed', 'profiles-initialized']) writeFileSync(path.join(state, marker), '');
    function remap(text) {
      return text.replaceAll('/data/adb/adblockpro', shellPath(runtime))
        .replaceAll('/data/adb/bindhosts_personal', shellPath(state))
        .replaceAll('/data/adb/modules/bindhosts_personal', shellPath(module))
        .replaceAll('/data/adb/modules/AdGuardHome', shellPath(path.join(root.dir, 'absent-conflicting-module')));
    }
    const files = ['action.sh', 'module.prop', 'service.sh', 'uninstall.sh', 'bindhosts.sh',
      'webui-config.sh', 'webui-job.sh', 'settings.conf', 'config-blacklist.txt', 'config-whitelist.txt',
      'rules/shared-app-domains.txt', 'rules/source-registry.tsv', 'certs/cacert.pem',
      ...readdirSync(new URL('../scripts/', import.meta.url)).map(name => 'scripts/' + name),
      ...readdirSync(new URL('../webroot/', import.meta.url)).map(name => 'webroot/' + name)];
    for (const file of files) {
      const target = path.join(stage, file); mkdirSync(path.dirname(target), { recursive: true });
      const content = file === 'scripts/compat.sh' ? readFileSync(root.compatFile, 'utf8')
        : readFileSync(new URL('../' + file, import.meta.url), 'utf8');
      writeFileSync(target, remap(content));
    }
    mkdirSync(path.join(stage, 'bin/data/filters'), { recursive: true });
    writeFileSync(path.join(stage, 'bin/AdGuardHome'), 'fixture-only-replacement-binary');
    writeFileSync(path.join(stage, 'bin/curl'), '#!/bin/sh\necho "curl fixture"\n');
    writeFileSync(path.join(stage, 'bin/adblock-ai'), '#!/bin/sh\necho "AI fixture"\n');
    writeFileSync(path.join(stage, 'bin/adblock-apps.dex'), 'application-label-fixture');
    writeFileSync(path.join(stage, 'bin/adblock-bootstrap'), '#!/bin/sh\nexit 0\n');
    for (const file of ['10007.txt', '1791638912.txt']) writeFileSync(path.join(stage, 'bin/data/filters', file), 'new-default-cache');
    const zip = path.join(root.dir, 'candidate.zip');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const packed = spawnSync(python, ['-c', 'from pathlib import Path\nimport sys,zipfile\np=Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for f in p.rglob("*"):\n  if f.is_file(): z.write(f,f.relative_to(p).as_posix())', stage, zip], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const installer = remap(readFileSync(new URL('../customize.sh', import.meta.url), 'utf8'));
    const commands = 'ui_print() { :; }\nabort() { echo "$1" >&2; exit 1; }\ngetprop() { echo arm64-v8a; }\niptables() { return 0; }\nchown() { :; }\n';
    const script = path.join(root.dir, 'install-test.sh');
    writeFileSync(script, (commands + installer).replaceAll('\r\n', '\n'));
    const result = spawnSync('bash', [shellPath(script)], {
      encoding: 'utf8', timeout: 20000,
      env: { ...root.env(family), MODPATH: shellPath(module), TMPDIR: shellPath(root.dir), ZIPFILE: shellPath(zip) },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(path.join(runtime, 'certs/cacert.pem'), 'utf8'), readFileSync(new URL('../certs/cacert.pem', import.meta.url), 'utf8'));
    for (const [file, content] of privateFiles) assert.equal(readFileSync(file, 'utf8'), content, file + ' changed during upgrade');
    assert.equal(readFileSync(path.join(state, 'root-family'), 'utf8').trim(), family);
    assert.equal(readFileSync(path.join(runtime, 'bin/AdGuardHome'), 'utf8'), 'fixture-only-replacement-binary');
    assert.equal(readFileSync(path.join(runtime, 'bin/adblock-apps.dex'), 'utf8'), 'application-label-fixture');
    assert.equal(readFileSync(path.join(runtime, 'scripts/compat.sh'), 'utf8'), readFileSync(path.join(module, 'scripts/compat.sh'), 'utf8'));
  });
}
