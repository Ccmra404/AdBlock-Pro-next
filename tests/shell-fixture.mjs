import { readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const shellPath = value => process.platform === 'win32'
  ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
  : value;

export function rootFixture(t, incomplete = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'abp-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {
    KernelSU: path.join(dir, 'ksu/bin/busybox'),
    Magisk: path.join(dir, 'magisk/busybox'),
    APatch: path.join(dir, 'ap/bin/busybox'),
  };
  let compat = readFileSync(new URL('../scripts/compat.sh', import.meta.url), 'utf8');
  compat = compat.replace('$(command -v busybox 2>/dev/null)', '');
  compat = compat.replaceAll('/data/adb/bindhosts_personal/root-family', shellPath(path.join(dir, 'root-family')));
  for (const [prefix, local] of [
    ['/data/adb/ksu', path.join(dir, 'ksu')],
    ['/data/adb/magisk', path.join(dir, 'magisk')],
    ['/data/adb/ap', path.join(dir, 'ap')],
  ]) compat = compat.replaceAll(prefix, shellPath(local));
  const compatFile = path.join(dir, 'scripts/compat.sh');
  mkdirSync(path.dirname(compatFile), { recursive: true });
  writeFileSync(compatFile, compat);

  function addBusybox(family) {
    const file = paths[family];
    mkdirSync(path.dirname(file), { recursive: true });
    const applets = ['sh', 'awk', 'flock', 'nohup', 'setuidgid', 'inotifyd'].filter(x => x !== incomplete);
    // Tool-selection fixture; it does not emulate Android privileges or locking.
    writeFileSync(file, `#!/bin/sh
if [ "$1" = --list ]; then printf '%s\\n' ${applets.join(' ')}; exit 0; fi
case "$1" in
  flock) shift; [ "$1" != -n ] || shift; shift; exec "$@" ;;
  sh) shift; exec bash "$@" ;;
  *) exec "$@" ;;
esac
`);
    chmodSync(file, 0o755);
  }
  function env(family = '') {
    return { ...process.env, BB: '', KSU: family === 'KernelSU' ? 'true' : '',
      APATCH: family === 'APatch' ? 'true' : '', MAGISK_VER_CODE: family === 'Magisk' ? '30000' : '' };
  }
  return { dir, paths, compatFile, addBusybox, env };
}
