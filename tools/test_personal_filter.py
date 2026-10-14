#!/usr/bin/env python3
"""Exercise personal rules and memory-only observation with the real ARM64 core.

Uses isolated temporary data and loopback ports; never reads device credentials
or downloads subscription lists. Intended for the native ARM64 package job.
"""
import argparse
import base64
import json
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def exercise(engine, bootstrap):
    with tempfile.TemporaryDirectory(prefix='abp-personal-') as directory:
        root = Path(directory)
        config, auth = root / 'AdGuardHome.yaml', root / 'admin.auth'
        subprocess.run([str(bootstrap), str(config), str(auth)], check=True, capture_output=True)
        personal = root / 'bin/userfilters/adblock-pro-user-rules.txt'
        personal.parent.mkdir(parents=True)
        # Use generic test-only names instead of shipping a maintainer's
        # device-specific personal block list in the public repository.
        domains = ['first-boot-regression.example', 'second-boot-regression.example']
        personal.write_text('\n'.join('||' + domain + '^' for domain in domains) + '\n')
        shared = personal.with_name('adblock-pro-shared-app-rules.txt')
        bundled = Path(__file__).resolve().parents[1] / 'rules/shared-app-domains.txt'
        shared_domains = [row for row in bundled.read_text().splitlines() if row and not row.startswith('#')]
        assert len(shared_domains) == 29
        shared.write_text('\n'.join('||' + domain + '^' for domain in shared_domains) + '\n')
        text = config.read_text()
        assert 'url: /data/adb/adblockpro/bin/userfilters/adblock-pro-user-rules.txt' in text
        http_port, dns_port = free_port(), free_port()
        text = text.replace('/data/adb/adblockpro', str(root))
        text = text.replace('127.0.0.1:3000', f'127.0.0.1:{http_port}').replace('port: 5591', f'port: {dns_port}')
        # Retain only the local personal filter for this isolated test. Remote
        # production sources remain unchanged in the generated installer.
        before, filters = text.split('filters:\n', 1)
        _, after = filters.split('querylog:\n', 1)
        local = filters[filters.index('  - enabled: true\n    url: ' + str(shared)):].split('querylog:\n')[0]
        text = before + 'filters:\n' + local + 'querylog:\n' + after
        text += 'user_rules:\n  - "||native-regression.example^"\n'
        config.write_text(text)
        credential = base64.b64encode(auth.read_text().strip().encode()).decode()

        def api(route, body=None):
            request = urllib.request.Request(f'http://127.0.0.1:{http_port}/control' + route,
                data=None if body is None else json.dumps(body).encode(),
                headers={'Authorization': 'Basic ' + credential, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=5) as response:
                data = response.read()
                return json.loads(data) if data else None

        def blocked(domain):
            result = api('/filtering/check_host?name=' + urllib.parse.quote(domain))
            return result['reason'].startswith('Filtered')

        def dns_query(domain):
            name = b''.join(bytes([len(label)]) + label.encode('ascii') for label in domain.split('.')) + b'\0'
            packet = struct.pack('!6H', 0x4142, 0x0100, 1, 0, 0, 0) + name + struct.pack('!2H', 1, 1)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.settimeout(5)
                client.sendto(packet, ('127.0.0.1', dns_port))
                reply, _ = client.recvfrom(4096)
            assert len(reply) >= 12 and reply[:2] == packet[:2] and reply[2] & 0x80, 'DNS probe did not receive a matching response'

        def wait_until(check, message='Local filter application timeout'):
            for _ in range(100):
                if check():
                    return
                time.sleep(0.1)
            raise AssertionError(message)

        with (root / 'engine.log').open('wb') as log:
            process = subprocess.Popen([str(engine), '--config', str(config), '--work-dir', str(root)], stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('AdGuard Home exited before its API became ready')
                    try:
                        api('/status')
                        break
                    except (OSError, ValueError):
                        time.sleep(0.1)
                else:
                    raise RuntimeError('AdGuard Home API readiness timeout')
                assert api('/querylog_info')['enabled'] is False, 'fresh config migration re-enabled query logging'
                persisted_querylog = config.read_text().split('querylog:\n', 1)[1].split('statistics:\n', 1)[0]
                assert 'file_enabled: false' in persisted_querylog, 'fresh config migration re-enabled disk query logging'
                wait_until(lambda: blocked(domains[0]))
                for domain in domains:
                    assert blocked(domain), 'bundled personal domain not applied: ' + domain
                assert blocked('native-regression.example')
                for domain in shared_domains:
                    assert blocked(domain), 'offline shared domain not applied: ' + domain
                # Exercise the same memory-only API snapshot and actual WebUI
                # parser as observation, without using an Android device.
                previous = api('/querylog_info')
                started_at = int(time.time() * 1000)
                try:
                    api('/querylog_config', {**previous, 'enabled': True, 'anonymize_client_ip': True})
                    assert api('/querylog_info')['enabled'] is True, 'temporary query logging did not enable'
                    dns_query(domains[0])
                    def has_probe():
                        return any(entry.get('question', {}).get('name', '').rstrip('.') == domains[0]
                                   for entry in api('/querylog?limit=200')['data'])
                    wait_until(has_probe, 'Memory-only DNS query was not captured')
                    snapshot = api('/querylog?limit=200')
                    parser_test = r"""
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const begin = source.indexOf('function validObservedDomain(');
const end = source.indexOf('async function loadObservationResult(');
if (begin < 0 || end <= begin) throw new Error('Observation parser functions missing');
const parse = vm.runInNewContext(source.slice(begin, end) + ';parseObservedDomains');
const result = parse(fs.readFileSync(0, 'utf8'), Number(process.argv[3]));
if (!result.some(item => item.domain === process.argv[2])) throw new Error('Live core snapshot lost the probe domain in WebUI parsing');
"""
                    subprocess.run(['node', '-e', parser_test,
                                    str(Path(__file__).resolve().parents[1] / 'webroot/app.js'),
                                    domains[0], str(started_at)], input=json.dumps(snapshot),
                                   text=True, capture_output=True, check=True)
                finally:
                    api('/querylog_config', previous)
                restored = api('/querylog_info')
                for key in ('enabled', 'interval', 'anonymize_client_ip'):
                    assert restored[key] == previous[key], 'temporary query-log preference not restored: ' + key
                assert not list(root.rglob('querylog.json*')), 'memory-only observation wrote a disk query log'
                # A later personal-file change must be applied on refresh,
                # without replacing native user_rules or doubling sources.
                personal.write_text('||custom-regression.example^\n||allowed-regression.example^\n@@||allowed-regression.example^\n@@||' + shared_domains[0] + '^\n')
                api('/filtering/refresh', {'whitelist': False, 'force': True})
                wait_until(lambda: blocked('custom-regression.example') and not blocked(domains[0]))
                assert blocked('custom-regression.example')
                assert not blocked('allowed-regression.example')
                assert not blocked(domains[0]), 'removed personal rule still active'
                assert blocked('native-regression.example'), 'native custom rules overwritten'
                assert not blocked(shared_domains[0]), 'personal whitelist cannot override shared filter'
                filters = api('/filtering/status')['filters']
                assert sum(item['url'] == str(personal) for item in filters) == 1
                assert sum(item['url'] == str(shared) for item in filters) == 1
                shared.write_text('||shared-refresh-regression.example^\n')
                api('/filtering/refresh', {'whitelist': False, 'force': True})
                wait_until(lambda: blocked('shared-refresh-regression.example') and not blocked(shared_domains[1]))
                assert blocked('custom-regression.example'), 'shared refresh removed a personal rule'
                assert blocked('native-regression.example'), 'shared refresh removed a native rule'
                assert api('/querylog_info')['enabled'] is False, 'filter refresh altered query-log preference'
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    print('Native ARM64: personal rules, refresh, whitelist, native user_rules and memory-only observation parsing passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--bootstrap', type=Path, required=True)
    args = parser.parse_args()
    exercise(args.engine.resolve(), args.bootstrap.resolve())
