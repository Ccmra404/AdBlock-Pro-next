#!/usr/bin/env python3
"""Issue #52 packet-path regression in a disposable Linux network namespace.

Uses local DNS stubs and real iptables/SO_MARK. This verifies kernel matching,
not Android VPN routing, FlClash behavior or actual AGH filtering on a phone.
"""
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import threading


ROOT = Path(__file__).resolve().parents[1]
LOCAL = b'\xcb\x00\x71\x09'       # 203.0.113.9: intercepted DNS stub
UPSTREAM = b'\xc6\x33\x64\x09'    # 198.51.100.9: original DNS stub
QUERY_PORT = 30000


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=15)


def receive(sock, size):
    data = b''
    while len(data) < size:
        part = sock.recv(size - len(data))
        if not part:
            raise RuntimeError('truncated TCP DNS response')
        data += part
    return data


def query(protocol, mark, name='normal.example'):
    global QUERY_PORT
    QUERY_PORT += 1
    question = b''.join(bytes([len(label)]) + label.encode() for label in name.split('.'))
    wire = struct.pack('!6H', 0x5252, 0x0100, 1, 0, 0, 0) + question + b'\0\0\1\0\1'
    kind = socket.SOCK_STREAM if protocol == 'tcp' else socket.SOCK_DGRAM
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.settimeout(2)
        # Use fresh tuples so prior NAT conntrack entries cannot mask a rule change.
        sock.bind(('127.0.0.1', QUERY_PORT))
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, struct.pack('=I', mark))
        sock.connect(('127.0.0.2', 53))
        if protocol == 'tcp':
            sock.sendall(struct.pack('!H', len(wire)) + wire)
            answer = receive(sock, struct.unpack('!H', receive(sock, 2))[0])
        else:
            sock.send(wire)
            answer = sock.recv(4096)
    assert answer[:2] == wire[:2], 'DNS response ID mismatch'
    if answer[3] & 15 == 3:
        return 'blocked'
    return 'local' if answer[-4:] == LOCAL else 'upstream' if answer[-4:] == UPSTREAM else 'invalid'


class DNS(socketserver.BaseRequestHandler):
    def handle(self):
        if self.server.protocol == 'udp':
            data, sock = self.request
        else:
            sock = self.request
            data = receive(sock, struct.unpack('!H', receive(sock, 2))[0])
        blocked = self.server.address == LOCAL and b'\x07blocked\x07example\0' in data
        flags, count = (0x8183, 0) if blocked else (0x8180, 1)
        response = data[:2] + struct.pack('!5H', flags, 1, count, 0, 0) + data[12:]
        if not blocked:
            response += b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 0, 4) + self.server.address
        if self.server.protocol == 'udp':
            sock.sendto(response, self.client_address)
        else:
            sock.sendall(struct.pack('!H', len(response)) + response)


def start_stub(address, port, protocol, result):
    factory = socketserver.ThreadingUDPServer if protocol == 'udp' else socketserver.ThreadingTCPServer
    server = factory((address, port), DNS)
    server.daemon_threads = True
    server.protocol, server.address = protocol, result
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def exercise():
    run('ip', 'link', 'set', 'lo', 'up')
    servers = [start_stub(host, port, protocol, result)
               for protocol in ('udp', 'tcp')
               for host, port, result in [('127.0.0.1', 5591, LOCAL), ('127.0.0.2', 53, UPSTREAM)]]
    checked = 0
    try:
        # Reproduce v0.13.5's interception of a VPN-protected socket.
        run('iptables', '-t', 'nat', '-N', 'ABP_ISSUE52_BASELINE')
        run('iptables', '-t', 'nat', '-A', 'ABP_ISSUE52_BASELINE', '-m', 'owner',
            '--uid-owner', '0', '--gid-owner', '3004', '-j', 'RETURN')
        for protocol in ('udp', 'tcp'):
            run('iptables', '-t', 'nat', '-A', 'ABP_ISSUE52_BASELINE', '-p', protocol,
                '--dport', '53', '-j', 'REDIRECT', '--to-ports', '5591')
        run('iptables', '-t', 'nat', '-I', 'OUTPUT', '-j', 'ABP_ISSUE52_BASELINE')
        for protocol in ('udp', 'tcp'):
            assert query(protocol, 0x20065) == 'local', 'legacy protected DNS was not intercepted'
            checked += 1
        run('iptables', '-t', 'nat', '-D', 'OUTPUT', '-j', 'ABP_ISSUE52_BASELINE')
        run('iptables', '-t', 'nat', '-F', 'ABP_ISSUE52_BASELINE')
        run('iptables', '-t', 'nat', '-X', 'ABP_ISSUE52_BASELINE')

        # Execute the production chain builder, not a hand-written copy of the fix.
        source = (ROOT / 'scripts/iptables.sh').read_text()
        source = re.sub(r'^\. /data/adb/adblockpro/(settings.conf|scripts/base.sh)\r?$', '', source, flags=re.M)
        source = source[:source.index('\ncase "$1" in\n')]
        setup = '\nadg_user=0; adg_group=3004; redir_port=5591\nignore_dest_list=""; ignore_src_list=""\nlog() { :; }\n'
        run('bash', '-c', source + setup + 'enable_iptables_chain "$iptables_w" ADGUARD_REDIRECT_DNS')

        cases = [
            (0, 'local'), (0x65, 'local'), (0x10065, 'local'),
            (0x20065, 'upstream'), (0x30065, 'upstream'), (0x120065, 'upstream'),
            (0x60065, 'local'), (0xe0065, 'local'), (0xf0065, 'local'),
            (0x40000065, 'local'), (0x80020065, 'upstream'),
        ]
        for protocol in ('udp', 'tcp'):
            for mark, expected in cases:
                actual = query(protocol, mark)
                assert actual == expected, f'{protocol} mark={mark:#x}: {actual}, expected {expected}'
                checked += 1
            for mark in (0, 0xe0065, 0xf0065):
                assert query(protocol, mark, 'blocked.example') == 'blocked', 'ordinary DNS filtering bypassed'
                checked += 1
            # Existing AGH UID/GID exemption remains effective (no mark needed).
            child = run(sys.executable, __file__, '--agh-query', protocol)
            assert child.stdout.strip() == 'upstream', 'AGH self-exemption changed'
            checked += 1
        print(f'Issue #52: {checked} real UDP/TCP netfilter checks passed in isolated namespace')
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    if sys.argv[1:] and sys.argv[1] in ('--agh-query', '--inside-namespace'):
        parent_ns = os.environ.get('ABP_ISSUE52_PARENT_NETNS')
        if not parent_ns or parent_ns == str(os.stat('/proc/self/ns/net').st_ino):
            sys.exit('Refusing test-only entry outside the isolated network namespace.')
    if sys.argv[1:] and sys.argv[1] == '--agh-query':
        os.setgid(3004)
        QUERY_PORT = 40000
        print(query(sys.argv[2], 0))
    elif sys.argv[1:] == ['--inside-namespace']:
        exercise()
    else:
        if sys.argv[1:]:
            sys.exit('Usage: sudo python3 tests/issue52_netfilter.py')
        if sys.platform != 'linux' or os.geteuid() != 0:
            sys.exit('Run this targeted regression with sudo on Linux; no device access is used.')
        for name in ('unshare', 'ip', 'iptables', 'bash'):
            if not shutil.which(name):
                sys.exit(f'Missing test-runner tool: {name}')
        # Nothing below can touch the host network: execute only after unshare succeeds.
        env = {**os.environ, 'ABP_ISSUE52_PARENT_NETNS': str(os.stat('/proc/self/ns/net').st_ino)}
        subprocess.run(['unshare', '--net', '--', sys.executable, __file__, '--inside-namespace'],
                       check=True, timeout=30, env=env)
