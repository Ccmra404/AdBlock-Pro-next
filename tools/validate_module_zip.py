#!/usr/bin/env python3
"""Validate a candidate installer without executing it or reading device data."""
import argparse
from pathlib import Path
import re
import struct
import zipfile

REQUIRED = {
    'module.prop', 'customize.sh', 'service.sh', 'uninstall.sh', 'action.sh',
    'bindhosts.sh', 'webui-config.sh', 'webui-job.sh', 'settings.conf',
    'config-blacklist.txt', 'config-whitelist.txt', 'webroot/index.html',
    'webroot/app.js', 'webroot/kernelsu.js', 'scripts/compat.sh',
    'scripts/tool.sh', 'scripts/base.sh', 'scripts/iptables.sh',
    'scripts/footprint.sh', 'scripts/memory.sh', 'scripts/detach.sh', 'META-INF/com/google/android/update-binary',
    'bin/AdGuardHome', 'bin/adblock-bootstrap',
    'bin/data/filters/10007.txt', 'bin/data/filters/1791638912.txt',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/AWAvenue-GPL-3.0.txt',
}


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
        if not REQUIRED.issubset(names):
            raise ValueError('missing installer files: ' + ', '.join(sorted(REQUIRED - set(names))))
        if archive.testzip() is not None:
            raise ValueError('corrupt ZIP entry')
        props = dict(line.split('=', 1) for line in archive.read('module.prop').decode().splitlines() if '=' in line)
        if props.get('id') != 'bindhosts_personal':
            raise ValueError('module identity changed')
        if props.get('version') != version or props.get('versionCode') != str(version_code):
            raise ValueError('incorrect candidate version metadata')
        for name in ['bin/AdGuardHome', 'bin/adblock-bootstrap']:
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
