#!/usr/bin/env python3
"""Validate a candidate installer without executing it or reading device data."""
import argparse
import hashlib
from pathlib import Path
import re
import ssl
import struct
import zipfile

REQUIRED = {
    'module.prop', 'customize.sh', 'service.sh', 'uninstall.sh', 'action.sh',
    'bindhosts.sh', 'webui-config.sh', 'webui-job.sh', 'settings.conf',
    'config-blacklist.txt', 'config-whitelist.txt', 'webroot/index.html',
    'webroot/app.js', 'webroot/kernelsu.js', 'scripts/compat.sh',
    'scripts/tool.sh', 'scripts/base.sh', 'scripts/iptables.sh',
    'scripts/rule-store.sh', 'rules/shared-app-domains.txt',
    'scripts/footprint.sh', 'scripts/memory.sh', 'scripts/detach.sh', 'META-INF/com/google/android/update-binary',
    'bin/AdGuardHome', 'bin/adblock-bootstrap',
    'bin/curl', 'bin/adblock-ai', 'certs/cacert.pem',
    'bin/data/filters/10007.txt', 'bin/data/filters/1791638912.txt',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/AWAvenue-GPL-3.0.txt',
    'licenses/curl-COPYING.txt', 'licenses/openssl-LICENSE.txt', 'licenses/cacert-MPL-2.0.txt',
    'licenses/go-openai-Apache-2.0.txt',
}
CA_SHA256 = 'a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505'


def validate(path, version, version_code):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('duplicate ZIP entries')
        for name in names:
            parts = name.split('/')
            if name.startswith('/') or '..' in parts or '\\' in name:
                raise ValueError('unsafe ZIP path')
            if re.search(r'(^|/)(admin\.auth|AdGuardHome\.yaml|[^/]+\.auth)$', name):
                raise ValueError('private credentials/configuration in ZIP')
            if 'ai' in parts[:-1]:
                raise ValueError('private AI configuration/results in ZIP')
        if not REQUIRED.issubset(names):
            raise ValueError('missing installer files: ' + ', '.join(sorted(REQUIRED - set(names))))
        if archive.testzip() is not None:
            raise ValueError('corrupt ZIP entry')
        ca_data = archive.read('certs/cacert.pem')
        if hashlib.sha256(ca_data).hexdigest() != CA_SHA256:
            raise ValueError('incorrect CA certificate bundle checksum')
        # Loading the PEM proves the package contains usable roots, not just a file.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        pem = b'\n'.join(re.findall(rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', ca_data, re.S))
        context.load_verify_locations(cadata=pem.decode('ascii'))
        if not context.cert_store_stats()['x509_ca']:
            raise ValueError('empty CA certificate store')
        props = dict(line.split('=', 1) for line in archive.read('module.prop').decode().splitlines() if '=' in line)
        if props.get('id') != 'bindhosts_personal':
            raise ValueError('module identity changed')
        if props.get('version') != version or props.get('versionCode') != str(version_code):
            raise ValueError('incorrect candidate version metadata')
        if props.get('updateJson') != 'https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest/download/update.json':
            raise ValueError('incorrect Root-manager update URL')
        for name in ['bin/AdGuardHome', 'bin/adblock-bootstrap', 'bin/curl', 'bin/adblock-ai']:
            with archive.open(name) as binary:
                header = binary.read(64)
            if len(header) < 64 or header[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', header, 18)[0] != 183:
                raise ValueError('not an ARM64 ELF: ' + name)
            if not (archive.getinfo(name).external_attr >> 16) & 0o111:
                raise ValueError('binary lacks execute permission: ' + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--version-code', required=True)
    args = parser.parse_args()
    validate(args.path, args.version, args.version_code)
    print('Installer ZIP integrity, ARM64, metadata and credential checks passed.')


if __name__ == '__main__':
    main()
