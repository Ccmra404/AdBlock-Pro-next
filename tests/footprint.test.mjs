import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import { shellPath } from './shell-fixture.mjs';

const helper = new URL('../scripts/footprint.sh', import.meta.url);
const jobScript = readFileSync(new URL('../webui-job.sh', import.meta.url), 'utf8');
const diagnoseScript = readFileSync(new URL('../bindhosts.sh', import.meta.url), 'utf8');

function runFixture(t, processPresent = true, migrated = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'abp-footprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agh = path.join(root, 'runtime');
  const moduleDir = path.join(root, 'module');
  const state = path.join(root, 'state');
  const physicalState = migrated ? path.join(agh, 'state') : state;
  const proc = path.join(root, 'proc');
  for (const dir of [path.join(agh, 'bin', 'data', 'filters'), moduleDir,
                     path.join(physicalState, 'webui-jobs'), path.join(physicalState, 'dns-history'), proc])
    mkdirSync(dir, { recursive: true });
  if (migrated) symlinkSync(physicalState, state, 'dir');
  const engine = path.join(agh, 'bin', 'AdGuardHome');
  writeFileSync(engine, Buffer.alloc(14000, 65));
  writeFileSync(path.join(agh, 'bin', 'data', 'filters', '10007.txt'), '||ads.example^\n');
  writeFileSync(path.join(state, 'webui-jobs', '100.log'), 'diagnostics\n');
  writeFileSync(path.join(state, 'dns-history', 'one.tar.gz'), 'snapshot\n');
  if (processPresent) {
    writeFileSync(path.join(agh, 'bin', 'agh.pid'), '1234\n');
    mkdirSync(path.join(proc, '1234'));
    writeFileSync(path.join(proc, '1234', 'cmdline'), shellPath(engine) + '\0-c\0');
    writeFileSync(path.join(proc, '1234', 'status'), 'Name:\tAdGuardHome\nVmRSS:\t40960 kB\n');
    writeFileSync(path.join(proc, '1234', 'stat'), '1234 (AdGuardHome) S ' + Array(18).fill('0').join(' ') + ' 12345\n');
    writeFileSync(path.join(proc, '1234', 'smaps_rollup'), '0000-aaaa r--p\nRss:\t40960 kB\nPss:\t30720 kB\n');
  }
  const output = spawnSync('bash', [shellPath(fileURLToPath(helper))], {
    timeout: 10000,
    encoding: 'utf8',
    env: {
      ...process.env,
      ABP_AGH_DIR: shellPath(agh), ABP_MODULE_DIR: shellPath(moduleDir),
      ABP_STATE_DIR: shellPath(state), ABP_PROC_DIR: shellPath(proc),
    },
  });
  assert.equal(output.status, 0, output.stderr);
  const values = Object.fromEntries(
    output.stdout.trim().split('\n').map(row => {
      const index = row.indexOf('=');
      return [row.slice(0, index), row.slice(index + 1)];
    }),
  );
  if (migrated) {
    const diskSize = target => Number(spawnSync('du', ['-sk', target], { encoding: 'utf8' }).stdout.split(/\s/)[0]);
    assert.equal(Number(values.diag_disk_state_kb), diskSize(state + '/'));
    assert.equal(Number(values.diag_disk_runtime_kb), diskSize(agh) - diskSize(state + '/'));
  }
  return values;
}

test('disk report measures real installed paths without reading private configs', t => {
  const result = runFixture(t);
  assert(Number(result.diag_disk_engine_binary_kb) >= 12);
  assert(Number(result.diag_disk_filter_cache_kb) > 0);
  assert(Number(result.diag_disk_task_logs_kb) > 0);
  assert(Number(result.diag_disk_rollback_kb) > 0);
  assert.equal(result.diag_mem_rss_kb, '40960');
  assert.equal(result.diag_mem_pss_kb, '30720');
  assert(Object.keys(result).every(key => key.startsWith('diag_')));
});

test('missing process reports unavailable RAM instead of fabricating zeros', t => {
  const result = runFixture(t, false);
  assert.equal(result.diag_mem_rss_kb, 'unavailable');
  assert.equal(result.diag_mem_pss_kb, 'unavailable');
});

test('migrated state is measured through its compatibility link without double counting', t => {
  const result = runFixture(t, false, true);
  assert(Number(result.diag_disk_state_kb) > 0);
  assert(Number(result.diag_disk_runtime_kb) >= Number(result.diag_disk_engine_binary_kb));
});

test('status polling remains lightweight: footprint is only on diagnostics', () => {
  const statusBody = diagnoseScript.split('status() {')[1].split('save_snapshot() {')[0];
  assert.doesNotMatch(statusBody, /footprint.sh/);
  assert.match(diagnoseScript, /--storage-report\)/);
  assert.match(diagnoseScript, /AGH\/scripts\/footprint.sh/);
});

test('completed operation logs are limited to 64 KiB while preserving retention', () => {
  assert.match(jobScript, /-gt 65536/);
  assert.match(jobScript, /tail -c 65536/);
  assert.match(jobScript, /tail -n \+201/);
  assert.doesNotMatch(jobScript, /262144/);
});
