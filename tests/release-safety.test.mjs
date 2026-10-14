import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
