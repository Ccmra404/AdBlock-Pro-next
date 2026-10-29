#!/usr/bin/env python3
"""Validate the public source registry and optionally probe its HTTPS mirrors."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import ssl
import sys
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, HTTPSHandler

ROOT = Path(__file__).resolve().parents[1]
IDS = {'10007', 'awa-full', 'goodbyeads', 'goodbyeads-allow', 'shared'}
REGISTRY_MIRRORS = (
    'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/source-registry.tsv',
    'https://gcore.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/source-registry.tsv',
    'https://cdn.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/source-registry.tsv',
    'https://ghfast.top/raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/source-registry.tsv',
)
PATH_PATTERN = re.compile(r'/[A-Za-z0-9._~%/@:+-]*\Z')
LABEL_PATTERN = re.compile(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\Z')


def valid_url(url):
    if len(url) > 1200 or not url.startswith('https://'):
        return False
    try:
        parsed = urlsplit(url)
        host = parsed.netloc.lower()
        labels = host.split('.')
        return (not parsed.query and not parsed.fragment and len(host) <= 253 and len(labels) >= 2
                and not labels[-1].isdigit() and labels[-1] not in {'local', 'localhost', 'internal', 'lan', 'home'}
                and all(0 < len(label) <= 63 and LABEL_PATTERN.fullmatch(label) for label in labels)
                and PATH_PATTERN.fullmatch(parsed.path) is not None)
    except ValueError:
        return False


def parse_registry(text):
    if len(text.encode('utf-8')) > 16384:
        raise ValueError('registry exceeds 16 KiB')
    revision, rows, counts, seen = None, [], {}, set()
    for line in text.splitlines():
        if line.startswith('# revision: '):
            value = line.removeprefix('# revision: ')
            if revision is not None or not re.fullmatch(r'[1-9][0-9]{0,11}', value):
                raise ValueError('invalid or duplicate revision')
            revision = value
        elif line and not line.startswith('#'):
            parts = line.split('\t')
            if len(parts) != 2 or parts[0] not in IDS or not valid_url(parts[1]) or line in seen:
                raise ValueError('invalid or duplicate source entry')
            seen.add(line)
            rows.append(tuple(parts))
            counts[parts[0]] = counts.get(parts[0], 0) + 1
    if revision is None or set(counts) != IDS or len(rows) > 50 or max(counts.values(), default=0) > 10:
        raise ValueError('missing source group or too many entries')
    return revision, rows


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != 'https' or not valid_url('https://' + target.netloc + (target.path or '/')):
            raise ValueError('unsafe redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def valid_sample(source_id, body):
    if not body or body.startswith(b'\x1f\x8b') or b'\x00' in body:
        return False
    lower = body[:512].lower()
    if b'<!doctype html' in lower or b'<html' in lower or b'<head' in lower:
        return False
    if source_id == 'registry':
        try:
            parse_registry(body.decode('utf-8'))
            return True
        except (UnicodeError, ValueError):
            return False
    if source_id == 'shared':
        return bool(re.search(rb'(?m)^# revision: [0-9]+\r?$', body) and
                    re.search(rb'(?mi)^[a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*\r?$', body))
    if source_id == 'goodbyeads-allow':
        return bool(re.search(rb'(?m)^@@', body))
    return bool(re.search(rb'(?m)^(?:\|\||0\.0\.0\.0[ \t]|127\.0\.0\.1[ \t])', body))


def read_response(source_id, response):
    limit = 16384 if source_id == 'registry' else 65536 if source_id == 'shared' else 52428800
    declared = response.headers.get('Content-Length', '')
    expected = int(declared) if declared.isdigit() else None
    if expected is not None and expected > limit:
        raise ValueError('response exceeds size limit')
    sample, total, started = bytearray(), 0, time.monotonic()
    while True:
        chunk = response.read(65536)
        if time.monotonic() - started > 30:
            raise TimeoutError('download exceeded 30 seconds')
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValueError('response exceeds size limit')
        if len(sample) < 65536:
            sample.extend(chunk[:65536 - len(sample)])
    if expected is not None and total != expected:
        raise ValueError('incomplete response')
    if response.status != 200 or not valid_sample(source_id, sample):
        raise ValueError('non-text or unexpected rule sample')
    return total


def probe(entry):
    source_id, url = entry
    context = ssl.create_default_context(cafile=str(ROOT / 'certs/cacert.pem'))
    opener = build_opener(SafeRedirect(), HTTPSHandler(context=context))
    error = 'unknown'
    for attempt in range(2):
        try:
            request = Request(url, headers={'User-Agent': 'AdBlock-Pro-source-check/1.0', 'Accept-Encoding': 'identity'})
            with opener.open(request, timeout=8) as response:
                size = read_response(source_id, response)
            return source_id, url, True, f'HTTP 200, {size} bytes downloaded'
        except Exception as exc:
            error = type(exc).__name__
            if attempt == 0:
                time.sleep(1)
    return source_id, url, False, error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='probe each published mirror')
    parser.add_argument('registry', nargs='?', type=Path, default=ROOT / 'rules/source-registry.tsv')
    args = parser.parse_args()
    try:
        revision, rows = parse_registry(args.registry.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, ValueError) as exc:
        print(f'Invalid registry: {exc}', file=sys.stderr)
        return 1
    print(f'Registry revision: {revision}; {len(rows)} mirrors across {len(IDS)} source groups.')
    if not args.check:
        return 0
    print('Results reflect this runner network only; they do not prove availability in mainland China.')
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(probe, rows + [('registry', url) for url in REGISTRY_MIRRORS]))
    healthy = {source_id: 0 for source_id in IDS | {'registry'}}
    for source_id, url, ok, detail in results:
        host = urlsplit(url).hostname
        print(f'{source_id}\t{host}\t{"OK" if ok else "FAILED"}\t{detail}')
        if ok:
            healthy[source_id] += 1
        else:
            print(f'::warning title=Source mirror unavailable::{source_id} - {host} ({detail})')
    missing = sorted(key for key, count in healthy.items() if count == 0)
    if missing:
        print('No usable mirror in this network for: ' + ', '.join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
