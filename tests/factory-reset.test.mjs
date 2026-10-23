import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t, options = {}) {
  const root = rootFixture(t); root.addBusybox('Magisk');
  const agh = path.join(root.dir, 'agh'), state = path.join(root.dir, 'state'), module = path.join(root.dir, 'module');
  const defaults = path.join(agh, 'defaults'), jobs = path.join(state, 'webui-jobs'), exports = path.join(root.dir, 'exports');
  for (const dir of [path.join(defaults, 'filters'), path.join(agh, 'bin/data/filters'), path.join(agh, 'bin/userfilters'), jobs, module, path.join(state, 'ai')]) mkdirSync(dir, { recursive: true });
  const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  put(path.join(defaults, 'settings.conf'), 'enable_ipv6_dns=false\nblock_ipv6_dns=false\nredir_port=5591\n');
  put(path.join(defaults, 'config-blacklist.txt'), 'default.personal.example\n');
  put(path.join(defaults, 'config-whitelist.txt'), 'default-allow.example\n');
  put(path.join(defaults, 'filters/10007.txt'), '||default-10007.example^\n');
  put(path.join(defaults, 'filters/1791638912.txt'), '||default-awa.example^\n');
  put(path.join(agh, 'settings.conf'), 'custom_setting=true\n');
  put(path.join(agh, 'admin.auth'), 'private:old-password-hash\n');
  put(path.join(agh, 'bin/AdGuardHome.yaml'), 'old-user-config: true\n');
  put(path.join(agh, 'bin/data/filters/10007.txt'), '||old-cache.example^\n');
  put(path.join(agh, 'bin/userfilters/custom.txt'), '||old-user-filter.example^\n');
  put(path.join(state, 'blacklist.txt'), 'private-block.example\n');
  put(path.join(state, 'whitelist.txt'), 'private-allow.example\n');
  put(path.join(state, 'sources-v2.txt'), 'https://private.example/rules.txt\n');
  put(path.join(state, 'source-names.tsv'), 'https://private.example/rules.txt\tPrivate\n');
  put(path.join(state, 'custom-sources.txt'), 'https://private.example/rules.txt\n');
  put(path.join(state, 'dns-takeover'), 'off\n');
  put(path.join(state, 'vpn-compat'), 'on\n');
  put(path.join(state, 'autostart'), 'off\n');
  put(path.join(state, 'auto-update'), 'off\n');
  put(path.join(state, 'blocking-mode'), 'strict\n');
  put(path.join(state, 'root-family'), 'Magisk\n');
  put(path.join(state, 'ai/config.json'), '{"key":"private-secret"}\n');
  put(path.join(state, 'ai/worker.lock'), '');
  put(path.join(state, 'webui-jobs/worker.lock'), '');
  put(path.join(state, 'webui-jobs/2000.log'), 'current reset task\n');
  put(path.join(state, 'webui-jobs/2000.action'), '--factory-reset\n');
  put(path.join(state, 'webui-jobs/1000.log'), 'old log\n');
  put(path.join(state, 'webui-jobs/1000.done'), '0\n');
  put(path.join(module, 'webui-config.sh'), '#!/bin/sh\n');
  put(path.join(module, 'bindhosts.sh'), '#!/bin/sh\n');
  put(path.join(module, 'rules/shared-app-domains.txt'), 'shared.example\n');
  for (const file of ['scripts/factory-reset.sh', 'scripts/compat.sh']) {
    const content = file.endsWith('compat.sh') ? readFileSync(root.compatFile, 'utf8') : readFileSync(new URL('../scripts/factory-reset.sh', import.meta.url), 'utf8');
    put(path.join(root.dir, file), content);
  }
  const config = path.join(root.dir, 'webui-config.sh');
  put(config, `#!/bin/sh\n[ "$1" = init-sources ] || exit 1\nprintf '%s\\n' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt' shared > "$ABP_STATE_DIR/sources-v2.txt"\n`);
  const rules = path.join(root.dir, 'rule-store.sh');
  put(rules, `#!/bin/sh\nmkdir -p "$ABP_AGH_DIR/bin/userfilters"\nprintf '||shared.example^\\n' > "$ABP_AGH_DIR/bin/userfilters/adblock-pro-shared-app-rules.txt"\n`);
  const render = path.join(root.dir, 'render.sh');
  put(render, `#!/bin/sh\n[ "$1" = --render-user-rules ] || exit 1\nprintf '||%s^\\n' "$(cat "$ABP_STATE_DIR/blacklist.txt")" > "$ABP_AGH_DIR/bin/userfilters/adblock-pro-user-rules.txt"\n`);
  const bootstrap = path.join(root.dir, 'bootstrap.sh');
  put(bootstrap, `#!/bin/sh\ncat > "$1" <<'ABP_CONFIG'\nfiltering:\n  filtering_enabled: true\nfilters:\n  - enabled: true\n    url: https://rules.example/ads.txt\n    id: 10007\n  - enabled: true\n    url: /data/adb/adblockpro/bin/userfilters/shared.txt\n    id: 10001\nABP_CONFIG\nprintf 'admin:password\\n' > "$2"\n`);
  const trace = path.join(root.dir, 'service.trace');
  const tool = path.join(root.dir, 'tool.sh');
  put(tool, `#!/bin/sh\necho "$1" >> "$ABP_TRACE"\nif [ "$1" = stop ] && [ "${options.stopFailure ? '1' : '0'}" = 1 ]; then exit 1; fi\nif [ "$1" = start ] && [ "${options.firstStartFailure ? '1' : '0'}" = 1 ] && [ ! -f "$ABP_FIRST_START" ]; then touch "$ABP_FIRST_START"; exit 1; fi\nexit 0\n`);
  for (const file of [bootstrap, tool]) chmodSync(file, 0o755);
  const script = path.join(root.dir, 'scripts/factory-reset.sh');
  const env = {
    ...root.env('Magisk'), ABP_AGH_DIR: shellPath(agh), ABP_STATE_DIR: shellPath(state), ABP_MODULE_DIR: shellPath(module),
    ABP_JOBS_DIR: shellPath(jobs), ABP_TOOL: shellPath(tool), ABP_BOOTSTRAP: shellPath(bootstrap), ABP_CONFIG_SCRIPT: shellPath(config),
    ABP_RENDER_SCRIPT: shellPath(render), ABP_RULE_STORE: shellPath(rules), ABP_COMPAT: shellPath(root.compatFile), ABP_EXPORT_DIR: shellPath(exports),
    ABP_TRACE: shellPath(trace), ABP_FIRST_START: shellPath(path.join(root.dir, 'first-start')), ABP_TAR: options.tarFailure ? shellPath(path.join(root.dir, 'tar-fail.sh')) : 'tar',
  };
  if (options.tarFailure) { put(path.join(root.dir, 'tar-fail.sh'), '#!/bin/sh\nexit 1\n'); chmodSync(path.join(root.dir, 'tar-fail.sh'), 0o755); }
  const run = args => spawnSync('bash', [shellPath(script), ...args], { encoding: 'utf8', timeout: 15000, env });
  return { root, agh, state, module, jobs, exports, env, trace, run };
}

test('factory reset keeps full recovery private and exports only lists/preferences to Downloads', t => {
  const f = fixture(t); const result = f.run(['2000']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Root 私有完整备份和下载目录规则备份/);
  assert.match(result.stdout, /IPv6 DNS 接管仍关闭/);
  assert.match(readFileSync(path.join(f.agh, 'settings.conf'), 'utf8'), /enable_ipv6_dns=false/);
  assert.equal(readFileSync(path.join(f.agh, 'admin.auth'), 'utf8'), 'admin:password\n');
  assert.match(readFileSync(path.join(f.agh, 'bin/AdGuardHome.yaml'), 'utf8'), /filtering_enabled: true/);
  assert.equal(readFileSync(path.join(f.agh, 'bin/data/filters/10007.txt'), 'utf8'), '||default-10007.example^\n');
  assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), 'default.personal.example\n');
  assert.equal(readFileSync(path.join(f.state, 'whitelist.txt'), 'utf8'), 'default-allow.example\n');
  assert.equal(readFileSync(path.join(f.state, 'dns-takeover'), 'utf8'), 'on\n');
  assert.equal(readFileSync(path.join(f.state, 'vpn-compat'), 'utf8'), 'off\n');
  assert.equal(readFileSync(path.join(f.state, 'autostart'), 'utf8'), 'on\n');
  assert.equal(readFileSync(path.join(f.state, 'auto-update'), 'utf8'), 'on\n');
  assert.match(readFileSync(path.join(f.state, 'sources-v2.txt'), 'utf8'), /10007_auto/);
  assert.doesNotMatch(readFileSync(path.join(f.state, 'sources-v2.txt'), 'utf8'), /private\.example/);
  assert.equal(readFileSync(path.join(f.state, 'sources-applied.txt'), 'utf8'), 'https://rules.example/ads.txt\n');
  assert.equal(existsSync(path.join(f.state, 'ai/config.json')), false);
  assert.equal(existsSync(path.join(f.state, 'ai/worker.lock')), true);
  assert.equal(existsSync(path.join(f.agh, 'bin/userfilters/custom.txt')), false);
  assert.equal(existsSync(path.join(f.agh, 'bin/userfilters/adblock-pro-shared-app-rules.txt')), true);
  assert.equal(existsSync(path.join(f.agh, 'bin/userfilters/adblock-pro-user-rules.txt')), true);
  assert.match(readFileSync(path.join(f.state, 'user-filter-applied'), 'utf8'), /adblock-pro-user-rules\.txt/);
  assert.equal(existsSync(path.join(f.module, 'bindhosts.sh')), true);
  assert.equal(existsSync(path.join(f.jobs, '2000.log')), true);
  assert.equal(existsSync(path.join(f.jobs, '1000.log')), false);
  const privateDir = path.join(f.agh, 'backups');
  const backup = readdirSync(privateDir).find(name => name.endsWith('.tar.gz'));
  assert.ok(backup);
  assert.match(backup, /^AdBlock-Pro-default-settings-/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(privateDir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(privateDir, backup)).mode & 0o777, 0o600);
  }
  const backupContents = spawnSync('bash', ['-c', 'tar -tzf "$1"', 'audit-tar', shellPath(path.join(privateDir, backup))], { encoding: 'utf8' });
  assert.equal(backupContents.status, 0, backupContents.stderr);
  assert.match(backupContents.stdout, /module-state\/ai\/config\.json/);
  assert.match(backupContents.stdout, /adguard-home\/admin\.auth/);
  assert.doesNotMatch(backupContents.stdout, /\.tmp|backups\//, 'the backup must not contain itself or prior backup archives');
  assert.doesNotMatch(result.stderr, /file is the archive; skipping/);
  const exported = readdirSync(f.exports).filter(name => name.endsWith('.tar.gz'));
  assert.equal(exported.length, 1);
  const exportedText = spawnSync('bash', ['-c', 'tar -xOzf "$1"', 'audit-tar', shellPath(path.join(f.exports, exported[0]))], { encoding: 'utf8' });
  assert.equal(exportedText.status, 0, exportedText.stderr);
  assert.match(exportedText.stdout, /private-block\.example/);
  assert.doesNotMatch(exportedText.stdout, /private-secret|old-password-hash|private\.example|old-user-config|old log/);
  const exportedList = spawnSync('bash', ['-c', 'tar -tzf "$1"', 'audit-tar', shellPath(path.join(f.exports, exported[0]))], { encoding: 'utf8' });
  assert.doesNotMatch(exportedList.stdout, /ai\/|admin\.auth|AdGuardHome\.yaml|sources|webui-jobs|dns-history/);
  assert.match(exportedList.stdout, /vpn-compat/);
  assert.deepEqual(readFileSync(f.trace, 'utf8').trim().split('\n'), ['stop', 'start']);
});

test('backup failure aborts before DNS stop or any state mutation', t => {
  const f = fixture(t, { tarFailure: true }); const result = f.run(['2000']);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), 'private-block.example\n');
  assert.equal(readFileSync(path.join(f.agh, 'admin.auth'), 'utf8'), 'private:old-password-hash\n');
  assert.equal(existsSync(f.trace), false);
});

test('a failed Download export preserves the complete private backup and aborts before DNS stop', t => {
  const f = fixture(t);
  const tar = path.join(f.root.dir, 'export-fail.sh');
  writeFileSync(tar, '#!/bin/sh\ncase "$2" in *AdBlock-Pro-rules-settings*) exit 1 ;; esac\nexec tar "$@"\n');
  chmodSync(tar, 0o755); f.env.ABP_TAR = shellPath(tar);
  const result = f.run(['2000']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.trace), false);
  assert.equal(readFileSync(path.join(f.state, 'ai/config.json'), 'utf8'), '{"key":"private-secret"}\n');
  assert.equal(readdirSync(path.join(f.agh, 'backups')).filter(name => name.endsWith('.tar.gz')).length, 1);
  assert.equal(readdirSync(f.exports).length, 0);
});

test('backup staging excludes its destination when the download folder is nested under module state', t => {
  const f = fixture(t);
  const exportDir = path.join(f.state, 'backups');
  f.env.ABP_EXPORT_DIR = shellPath(exportDir);
  const result = f.run(['2000']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const backup = readdirSync(exportDir).find(name => name.endsWith('.tar.gz'));
  assert.ok(backup);
  const listing = spawnSync('bash', ['-c', 'tar -tzf "$1"', 'audit-tar', shellPath(path.join(exportDir, backup))], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /backups\/|\.tmp/);
  assert.doesNotMatch(result.stderr, /file is the archive; skipping/);
});

test('DNS stop failure preserves settings and never starts a reset', t => {
  const f = fixture(t, { stopFailure: true }); const result = f.run(['2000']);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), 'private-block.example\n');
  assert.equal(readFileSync(path.join(f.agh, 'admin.auth'), 'utf8'), 'private:old-password-hash\n');
  assert.deepEqual(readFileSync(f.trace, 'utf8').trim().split('\n'), ['stop']);
});

test('queued or running AI jobs block reset before backup or DNS changes', t => {
  const f = fixture(t);
  const queued = path.join(f.state, 'ai/jobs/123/result.json');
  mkdirSync(path.dirname(queued), { recursive: true });
  writeFileSync(queued, '{"status":"queued"}\n');
  const result = f.run(['2000']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AI analysis is still running/);
  assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), 'private-block.example\n');
  assert.equal(existsSync(f.exports), false);
  assert.equal(existsSync(f.trace), false);
  assert.equal(existsSync(path.join(f.agh, 'factory-reset.active')), false);
});

test('a failed fresh DNS start restores previous settings and attempts to restart them', t => {
  const f = fixture(t, { firstStartFailure: true }); const result = f.run(['2000']);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(f.state, 'blacklist.txt'), 'utf8'), 'private-block.example\n');
  assert.equal(readFileSync(path.join(f.agh, 'settings.conf'), 'utf8'), 'custom_setting=true\n');
  assert.equal(readFileSync(path.join(f.agh, 'admin.auth'), 'utf8'), 'private:old-password-hash\n');
  assert.equal(readFileSync(path.join(f.state, 'ai/config.json'), 'utf8'), '{"key":"private-secret"}\n');
  assert.deepEqual(readFileSync(f.trace, 'utf8').trim().split('\n'), ['stop', 'start', 'stop', 'start']);
});
