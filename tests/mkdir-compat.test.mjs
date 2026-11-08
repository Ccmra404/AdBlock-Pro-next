import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

function fixture(t) {
  const root = rootFixture(t);
  root.addBusybox('KernelSU');
  const bb = root.paths.KernelSU;
  const original = readFileSync(bb, 'utf8');
  // Model the reported kernel error for BusyBox's mkdir -p on absolute paths.
  writeFileSync(bb, original.replace('  *) exec "$@" ;;', `  mkdir)
    shift
    if [ "$1" = -p ]; then
      shift
      case "$1" in /*) echo "mkdir: can't create directory '/': Invalid argument" >&2; exit 1;; esac
      set -- -p "$@"
    fi
    [ "$1" != -- ] || shift
    case "$1" in /|.|..|*/.|*/..) echo "invalid mkdir target" >&2; exit 1;; esac
    if [ -n "\${ABP_TEST_BLOCKED:-}" ] && [ "$1" = "$ABP_TEST_BLOCKED" ]; then
      echo "simulated permission denied" >&2; exit 1
    fi
    exec mkdir -- "$@" ;;
  *) exec "$@" ;;`));
  const run = (args, extra = {}) => spawnSync('bash', ['-c', '. "$1" || exit; shift; abp_mkdir_p "$@"',
    'mkdir-test', shellPath(root.compatFile), ...args.map(shellPath)],
  { encoding: 'utf8', env: { ...root.env('KernelSU'), ...extra } });
  return { ...root, run };
}

test('creates missing directories despite the simulated absolute mkdir -p error', t => {
  const f = fixture(t);
  const first = path.join(f.dir, 'space dir', 'new', 'child');
  const second = path.join(f.dir, 'another', 'child');
  const result = f.run([first, second]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
  assert.equal(f.run([first + '/', '/']).status, 0);
});

test('keeps real failures and does not replace files or dangling links', t => {
  const f = fixture(t);
  const blocked = path.join(f.dir, 'blocked');
  const denied = f.run([blocked], { ABP_TEST_BLOCKED: shellPath(blocked) });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /simulated permission denied/);
  assert.equal(existsSync(blocked), false);
  const regularFile = path.join(f.dir, 'file');
  writeFileSync(regularFile, 'keep');
  assert.notEqual(f.run([path.join(regularFile, 'child')]).status, 0);
  assert.equal(readFileSync(regularFile, 'utf8'), 'keep');
  assert.notEqual(f.run(['']).status, 0);
  if (process.platform !== 'win32') {
    const dangling = path.join(f.dir, 'dangling');
    symlinkSync(path.join(f.dir, 'missing-target'), dangling);
    assert.notEqual(f.run([dangling]).status, 0);
  }
});

test('preserves symlink and parent-directory path semantics', t => {
  if (process.platform === 'win32') return t.skip('Unix symlink semantics');
  const f = fixture(t);
  mkdirSync(path.join(f.dir, 'real', 'nested'), { recursive: true });
  symlinkSync(path.join(f.dir, 'real', 'nested'), path.join(f.dir, 'link'));
  const target = shellPath(f.dir) + '/link/../created';
  const result = f.run([target]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(f.dir, 'real', 'created')), true);
  assert.equal(existsSync(path.join(f.dir, 'created')), false);
  assert.equal(f.run([shellPath(f.dir) + '/real/new/.']).status, 0);
  assert.equal(f.run([shellPath(f.dir) + '/real/new/..']).status, 0);
});
