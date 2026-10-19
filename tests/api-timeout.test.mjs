import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {rootFixture, shellPath} from './shell-fixture.mjs';

const source = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');
const api = source.slice(source.indexOf('api() {'), source.indexOf('\njson_top_bool() {'));
test('GET uses its timeout argument while POST retains body and fourth-argument timeout', t => {
  const f = rootFixture(t);
  const auth = path.join(f.dir, 'auth'); writeFileSync(auth, 'synthetic:fixture\n');
  const script = path.join(f.dir, 'api.sh');
  writeFileSync(script, [
    'AUTH_FILE=' + shellPath(auth), 'CURL=fake_curl', 'API=http://127.0.0.1:1/control',
    'fake_curl() { while [ "$#" -gt 0 ]; do case "$1" in --max-time) printf "timeout=%s\\n" "$2"; shift 2 ;; --data-binary) printf "body=%s\\n" "$2"; shift 2 ;; *) shift ;; esac; done; }',
    api, 'api GET /status 4', 'api GET /stats 3', 'api GET /querylog 8', 'api GET /status',
    `api POST /filtering/config '{"enabled":false}' 5`, `api POST /refresh '{}'`,
  ].join('\n'));
  const r = spawnSync('bash', [shellPath(script)], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'timeout=4', 'timeout=3', 'timeout=8', 'timeout=20',
    'timeout=5', 'body={"enabled":false}', 'timeout=20', 'body={}',
  ]);
});
