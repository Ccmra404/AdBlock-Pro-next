#!/usr/bin/env python3
"""Generate native Root-manager update metadata for an approved stable Release."""
import argparse
import json
from pathlib import Path
import re

REPO = 'Ccmra404/AdBlock-Pro-next'
UPDATE_URL = 'https://github.com/' + REPO + '/releases/latest/download/update.json'


def build_manifest(properties, tag):
    props = {}
    for line in properties.splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in props:
            raise ValueError('Malformed or duplicate module property')
        props[key] = value
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag) or props.get('version') != tag:
        raise ValueError('Update metadata requires the exact stable module version')
    if props.get('id') != 'bindhosts_personal' or props.get('updateJson') != UPDATE_URL:
        raise ValueError('Unexpected module identity or update endpoint')
    code = props.get('versionCode', '')
    if not re.fullmatch(r'[1-9][0-9]{0,9}', code) or int(code) > 2147483647:
        raise ValueError('versionCode must be a positive 32-bit integer')
    base = 'https://github.com/' + REPO + '/releases/download/' + tag + '/'
    return {
        'version': tag,
        'versionCode': int(code),
        'zipUrl': base + 'AdBlock-Pro-' + tag + '-arm64.zip',
        'changelog': base + 'changelog.md',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--module-prop', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = build_manifest(args.module_prop.read_text(encoding='utf-8'), args.tag)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
