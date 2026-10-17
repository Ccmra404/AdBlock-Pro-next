import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellPath } from './shell-fixture.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const triggers = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:\n'));

test('ordinary pushes cannot automatically publish or overwrite a release', () => {
  assert.doesNotMatch(triggers, /^\s+push:/m);
  assert.match(triggers, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /gh release upload|--clobber/);
  assert.match(workflow, /python3 tools\/release_guard\.py/);
  assert.match(workflow, /needs: package/);
});

test('PR ARM64 ZIP is always labelled a test build', () => {
  assert.match(triggers, /pull_request:/);
  assert.match(workflow, /GITHUB_REF" != refs\/heads\/main/);
  assert.match(workflow, /-dev\./);
  assert.match(workflow, /AdBlock-Pro-test-\$\{\{ github\.run_id \}\}-arm64/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test('bundled curl trusts the installed PEM bundle instead of Android old-hash CA paths', () => {
  const build = readFileSync(new URL('../tools/build_android_curl.sh', import.meta.url), 'utf8');
  assert.match(build, /--with-ca-bundle=\/data\/adb\/adblockpro\/certs\/cacert\.pem/);
  assert.match(build, /--without-ca-path/);
  assert.match(workflow, /cp -a META-INF scripts webroot rules certs/);
});

test('changes to every installable file family trigger ARM64 package validation', () => {
  for (const pattern of [
    'tools/bootstrap/**', 'customize.sh', 'module.prop', 'action.sh',
    'service.sh', 'uninstall.sh', 'bindhosts.sh', 'webui-config.sh',
    'webui-job.sh', 'scripts/**', 'rules/**', 'settings.conf', 'webroot/**',
    'META-INF/**', 'bin/AdGuardHome', 'bin/data/filters/**', 'certs/**',
  ]) {
    assert(triggers.includes('"' + pattern + '"'), pattern + ' must trigger packaging');
  }
});


test('unprivileged packaging cannot publish and validates exact candidate contents', () => {
  const packageJob = workflow.split('  package:')[1].split('  publish:')[0];
  assert.match(workflow.split('jobs:')[0], /contents: read/);
  assert.doesNotMatch(packageJob, /contents: write|gh release create/);
  assert.match(packageJob, /validate_module_zip.py/);
  assert.match(workflow, /sha256sum -c/);
  assert.match(workflow, /github.event.pull_request.head.sha/);
});

test('upstream automation stays on main and proposes Draft PRs only', () => {
  const tracker = readFileSync(new URL('../.github/workflows/update-adguard-home.yml', import.meta.url), 'utf8');
  assert.match(tracker, /github.ref == 'refs\/heads\/main'/);
  assert.match(tracker, /gh pr create --draft/);
  assert.doesNotMatch(tracker, /--clobber|gh release create|gh pr merge|push[^\n]*--force/);
  assert.match(tracker, /git diff --quiet FETCH_HEAD -- bin\/AdGuardHome upstream\/adguard-home.json/);
});

const releaseStep = workflow.slice(workflow.indexOf('      - name: Create a new immutable '));
const releaseScript = releaseStep.slice(releaseStep.indexOf('        run: |\n') + 15)
  .split('\n').map(line => line.replace(/^          /, '')).join('\n');

function publication(t, channel, tag = 'v0.13.0') {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'tools'));
  mkdirSync(path.join(dir, 'dist'));
  writeFileSync(path.join(dir, 'docs', `release-${tag}.md`), '中文更新日志。\n');
  writeFileSync(path.join(dir, 'tools/module_update.py'), readFileSync(new URL('../tools/module_update.py', import.meta.url)));
  writeFileSync(path.join(dir, 'module.prop'), `id=bindhosts_personal\nversion=${tag}\nversionCode=48\nupdateJson=https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest/download/update.json\n`);
  writeFileSync(path.join(dir, 'dist', `AdBlock-Pro-${tag}-arm64.zip`), 'fixture');
  const args = path.join(dir, 'args');
  const result = spawnSync('bash', ['-c', `gh() { printf '%s\\n' "$@" > "$RELEASE_ARGS"; }
${process.platform === 'win32' ? 'python3() { python "$@"; }' : ''}
${releaseScript.replaceAll('/tmp/release-notes.md', shellPath(path.join(dir, 'notes.md')))}`], {
    encoding: 'utf8', cwd: dir,
    env: { ...process.env, CHANNEL: channel, TAG: tag, GITHUB_SHA: 'a'.repeat(40), RELEASE_ARGS: shellPath(args) },
  });
  const manifest = path.join(dir, 'dist/update.json'), notes = path.join(dir, 'dist/changelog.md');
  return { ...result, args: existsSync(args) ? readFileSync(args, 'utf8') : null,
    manifest: existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null,
    notes: existsSync(notes) ? readFileSync(notes, 'utf8') : null };
}

test('manual publication defaults to the safer prerelease channel', () => {
  assert.match(triggers, /channel:[\s\S]*type: choice[\s\S]*default: prerelease[\s\S]*options:[\s\S]*- prerelease[\s\S]*- stable/);
  assert.match(workflow, /CHANNEL:.*inputs.channel.*prerelease/);
});

for (const channel of ['prerelease', 'stable']) {
  test('manual ' + channel + ' publication uses explicit prerelease and latest flags', t => {
    const result = publication(t, channel);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.args, new RegExp('--prerelease=' + (channel === 'prerelease') + '\\n'));
    assert.match(result.args, new RegExp('--latest=' + (channel === 'stable') + '\\n'));
    assert.match(result.args, /--target\na{40}\n/);
    if (channel === 'stable') {
      assert.deepEqual(result.manifest, {
        version: 'v0.13.0', versionCode: 48,
        zipUrl: 'https://github.com/Ccmra404/AdBlock-Pro-next/releases/download/v0.13.0/AdBlock-Pro-v0.13.0-arm64.zip',
        changelog: 'https://github.com/Ccmra404/AdBlock-Pro-next/releases/download/v0.13.0/changelog.md',
      });
      assert.equal(result.notes, '中文更新日志。\n');
      assert.match(result.args, /dist\/update.json/);
      assert.match(result.args, /dist\/changelog.md/);
    } else {
      assert.equal(result.manifest, null);
      assert.equal(result.notes, null);
      assert.doesNotMatch(result.args, /update.json|changelog.md/);
    }
  });
}

for (const [channel, tag] of [['unknown', 'v0.13.0'], ['stable', 'v0.13.0-rc.3'], ['stable', 'v0.13.0-dev.1234567']]) {
  test('invalid publication selection cannot call GitHub: ' + channel + ' / ' + tag, t => {
    const result = publication(t, channel, tag);
    assert.notEqual(result.status, 0);
    assert.equal(result.args, null);
  });
}
