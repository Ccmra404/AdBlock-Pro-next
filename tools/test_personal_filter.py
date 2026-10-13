#!/usr/bin/env python3
"""Exercise first-boot and refreshed personal rules with the real ARM64 core.

Uses isolated temporary data and loopback ports; never reads device credentials
or downloads subscription lists. Intended for the native ARM64 package job.
"""
import argparse
import base64
import json
from pathlib import Path
import socket
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
        text = config.read_text()
        assert 'url: /data/adb/adblockpro/bin/userfilters/adblock-pro-user-rules.txt' in text
        http_port, dns_port = free_port(), free_port()
        text = text.replace('/data/adb/adblockpro', str(root))
        text = text.replace('127.0.0.1:3000', f'127.0.0.1:{http_port}').replace('port: 5591', f'port: {dns_port}')
        # Retain only the local personal filter for this isolated test. Remote
        # production sources remain unchanged in the generated installer.
        before, filters = text.split('filters:\n', 1)
        _, after = filters.split('querylog:\n', 1)
        local = filters[filters.index('  - enabled: true\n    url: ' + str(personal)):].split('querylog:\n')[0]
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

        def wait_until(check):
            for _ in range(100):
                if check():
                    return
                time.sleep(0.1)
            raise AssertionError('Local filter application timeout')

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
                wait_until(lambda: blocked(domains[0]))
                for domain in domains:
                    assert blocked(domain), 'bundled personal domain not applied: ' + domain
                assert blocked('native-regression.example')
                # A later personal-file change must be applied on refresh,
                # without replacing native user_rules or doubling sources.
                personal.write_text('||custom-regression.example^\n||allowed-regression.example^\n@@||allowed-regression.example^\n')
                api('/filtering/refresh', {'whitelist': False, 'force': True})
                wait_until(lambda: blocked('custom-regression.example') and not blocked(domains[0]))
                assert blocked('custom-regression.example')
                assert not blocked('allowed-regression.example')
                assert not blocked(domains[0]), 'removed personal rule still active'
                assert blocked('native-regression.example'), 'native custom rules overwritten'
                filters = api('/filtering/status')['filters']
                assert sum(item['url'] == str(personal) for item in filters) == 1
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    print('Native ARM64 personal filter: first-boot rules, refresh, whitelist and native user_rules preservation passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--bootstrap', type=Path, required=True)
    args = parser.parse_args()
    exercise(args.engine.resolve(), args.bootstrap.resolve())
