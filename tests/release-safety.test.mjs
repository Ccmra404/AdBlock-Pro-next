import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
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

test('changes to every installable file family trigger ARM64 package validation', () => {
  for (const pattern of [
    'tools/bootstrap/**', 'customize.sh', 'module.prop', 'action.sh',
    'service.sh', 'uninstall.sh', 'bindhosts.sh', 'webui-config.sh',
    'webui-job.sh', 'scripts/**', 'rules/**', 'settings.conf', 'webroot/**',
    'META-INF/**', 'bin/AdGuardHome', 'bin/data/filters/**',
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
  const args = path.join(dir, 'args');
  const result = spawnSync('bash', ['-c', `gh() { printf '%s\\n' "$@" > "$RELEASE_ARGS"; }
${releaseScript.replaceAll('/tmp/release-notes.md', shellPath(path.join(dir, 'notes.md')))}`], {
    encoding: 'utf8', cwd: dir,
    env: { ...process.env, CHANNEL: channel, TAG: tag, GITHUB_SHA: 'a'.repeat(40), RELEASE_ARGS: shellPath(args) },
  });
  return { ...result, args: existsSync(args) ? readFileSync(args, 'utf8') : null };
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
  });
}

for (const [channel, tag] of [['unknown', 'v0.13.0'], ['stable', 'v0.13.0-rc.3'], ['stable', 'v0.13.0-dev.1234567']]) {
  test('invalid publication selection cannot call GitHub: ' + channel + ' / ' + tag, t => {
    const result = publication(t, channel, tag);
    assert.notEqual(result.status, 0);
    assert.equal(result.args, null);
  });
}
