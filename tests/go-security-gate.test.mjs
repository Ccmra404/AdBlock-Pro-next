import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const step = workflow.split('      - name: Scan module-owned Go helpers for known vulnerabilities\n')[1]?.split('      - name:')[0];
const script = step?.split('        run: |\n')[1]?.split('\n').map(line => line.replace(/^          /, '')).join('\n');

for (const failAt of ['', 'tools/ai', '/tmp/adblock-ai-native']) test(`Go security gate executes source and artifact scans, and fails closed: ${failAt || 'clean'}`, t => {
  assert.ok(script, 'packaging must retain its Go security gate');
  const f = rootFixture(t), bin = path.join(f.dir, 'bin'), calls = path.join(f.dir, 'calls');
  mkdirSync(bin); mkdirSync(path.join(f.dir, 'tools/bootstrap'), { recursive: true }); mkdirSync(path.join(f.dir, 'tools/ai'));
  const go = path.join(bin, 'go');
  writeFileSync(go, '#!/bin/sh\ncase "$1" in install) exit 0;; env) printf "%s\\n" "$TEST_GOPATH";; *) exit 1;; esac\n'); chmodSync(go, 0o755);
  const checker = path.join(bin, 'govulncheck');
  writeFileSync(checker, `#!/bin/sh
if [ "$1" = -mode=binary ]; then target=$2; else target=\${PWD##*/}; target=tools/$target; fi
printf '%s\\n' "$target" >> "$SCAN_CALLS"
[ "$target" != "$FAIL_AT" ] || exit 3
`); chmodSync(checker, 0o755);
  const result = spawnSync('bash', ['-c', script], { cwd: f.dir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_GOPATH: shellPath(f.dir), SCAN_CALLS: shellPath(calls), FAIL_AT: failAt } });
  assert.equal(result.status, failAt ? 3 : 0, JSON.stringify(result));
  const scanned = readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(scanned, failAt === 'tools/ai' ? ['tools/bootstrap', 'tools/ai'] : ['tools/bootstrap', 'tools/ai', '/tmp/adblock-bootstrap-native', '/tmp/adblock-ai-native']);
});
