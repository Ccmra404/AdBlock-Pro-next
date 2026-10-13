import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootFixture, shellPath } from './shell-fixture.mjs';

test('detached launch preserves command arguments and standard output', t => {
  const f = rootFixture(t); f.addBusybox('Magisk');
  const result = spawnSync('bash', [shellPath(path.resolve('scripts/detach.sh')), shellPath(f.paths.Magisk),
    shellPath(f.paths.Magisk), 'sh', '-c', 'printf "%s\\n" "$1"; printf "stderr-ok\\n" >&2', 'probe', 'literal ; $value'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'literal ; $value');
  assert.equal(result.stderr.trim(), 'stderr-ok');
});

test('a live detached daemon does not retain real update and worker flock locks', { skip: process.platform === 'win32' ? 'Requires Linux /proc and fcntl; exercised in both CI jobs.' : false }, t => {
  const f = rootFixture(t); f.addBusybox('Magisk');
  const code = `
import fcntl,os,pathlib,subprocess,sys
root,helper,bb=sys.argv[1:]
paths=[pathlib.Path(root)/'update.lock',pathlib.Path(root)/'worker.lock']
for detached in (False,True):
    handles=[open(p,'a+') for p in paths]
    for handle in handles:
        fcntl.flock(handle,fcntl.LOCK_EX)
        os.set_inheritable(handle.fileno(),True)
    command=[sys.executable,'-c','import time;print("ready",flush=True);time.sleep(60)']
    if detached: command=['bash',helper,bb]+command
    else: command=['bash','-c','exec "$@"','probe']+command
    daemon=subprocess.Popen(command,close_fds=False,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        assert daemon.stdout.readline().strip()=='ready'
        for handle in handles: handle.close()
        for file in paths:
            with open(file,'a+') as contender:
                try: fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB); available=True
                except BlockingIOError: available=False
                assert available==detached, (file,detached,available)
        assert daemon.poll() is None, 'daemon must remain running while its parent locks are available'
    finally:
        for handle in handles: handle.close()
        daemon.terminate();daemon.wait(timeout=5)
print('Real inherited locks reproduced; detached daemon releases both without exiting.')
`;
  const result = spawnSync('python3', ['-c', code, f.dir, path.resolve('scripts/detach.sh'), f.paths.Magisk],
    { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /detached daemon releases both/);
});
