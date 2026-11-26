#!/usr/bin/env python3
"""Proof-only heartbeat publication fault; never changes the signed desktop helper.

Run as instarproof: --execute ACTION STORE [REQUEST_UUID] [SERVER_EXPIRES_AT_MS]
The durable receipt precedes target creation and records its inode before immutability.
Release only removes the flag on that exact inode; it never deletes a real heartbeat.
After begin-secret, release requires an exact confirmed revoke or the server grant expiry.
Tests may use LOCKED_PROOF_TEST_ROOT inside the system temporary directory.
"""
import ctypes
import fcntl
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid

PROOF_STORE = '/Users/instarproof/.instar/desktop-helper/locked'
RECEIPT = '.proof-guard-ack.json'
IMMUTABLE = 2  # Darwin UF_IMMUTABLE
STALE_NS = 1_000_000_000
KEY = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.0$')


def process_start(pid):
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
                            capture_output=True, text=True, timeout=5)
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return ''  # ps distinguishes an absent pid from a failed observation
    if result.returncode == 0 and result.stdout.strip() and not result.stderr.strip():
        return result.stdout.strip()
    raise ValueError('cannot verify fixture driver process identity')


def checked_file(root, name, flags=os.O_RDONLY):
    fd = os.open(os.path.join(root, name), flags | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('refusing non-regular, foreign-owned or linked fixture file')
    return fd


def set_flags(fd, flags):
    if sys.platform != 'darwin':
        raise ValueError('immutable heartbeat fixture requires macOS')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fchflags(ctypes.c_int(fd), ctypes.c_uint(flags)) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def sync_dir(root):
    fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_receipt(root, receipt):
    fd, tmp = tempfile.mkstemp(prefix='.proof-guard-ack-write-', dir=root)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(receipt, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, os.path.join(root, RECEIPT))
        sync_dir(root)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_receipt(root):
    try:
        fd = checked_file(root, RECEIPT)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as f:
        r = json.load(f)
    if (r.get('schema') != 2 or not KEY.fullmatch(r.get('key', ''))
            or r.get('uid') != os.getuid() or not re.fullmatch(r'[a-f0-9]{32}', r.get('token', ''))
            or type(r.get('driverPid')) is not int or r['driverPid'] <= 0
            or not isinstance(r.get('driverStart'), str) or not r['driverStart']
            or type(r.get('expiresAt')) is not int or r['expiresAt'] <= 0
            or r.get('secretState') not in ('not-submitted', 'may-be-in-flight')
            or type(r.get('grantRevoked')) is not bool
            or r.get('phase') not in ('reserved', 'created')):
        raise ValueError('refusing unknown fixture receipt')
    if r['phase'] == 'created' and not all(type(r.get(k)) is int for k in ('dev', 'ino')):
        raise ValueError('fixture receipt has no exact inode')
    return r


def state_at(root):
    try:
        fd = checked_file(root, 'locked-state.json')
    except FileNotFoundError:
        return {}
    with os.fdopen(fd) as f:
        return json.load(f)


def observe(root, receipt):
    if not receipt or receipt['phase'] != 'created':
        raise ValueError('heartbeat fixture was not completely created')
    fd = checked_file(root, 'hb-' + receipt['key'])
    try:
        info = os.fstat(fd)
        if (info.st_dev, info.st_ino) != (receipt['dev'], receipt['ino']):
            raise ValueError('heartbeat fixture inode changed')
        frozen = getattr(info, 'st_flags', 0) == IMMUTABLE and info.st_mtime_ns == STALE_NS
        state = state_at(root)
        marker = (state.get('markers') or {}).get(receipt['key'])
        return {'key': receipt['key'], 'frozen': frozen, 'mtimeNs': str(info.st_mtime_ns),
                'ageMs': int(time.time() * 1000 - info.st_mtime * 1000),
                'marker': marker, 'dirty': state.get('dirty') is not None}
    finally:
        os.close(fd)


def arm(root, request, driver_pid, expires_at):
    key = request + '.0'
    if not KEY.fullmatch(key):
        raise ValueError('a fresh request UUID is required')
    now = int(time.time() * 1000)
    if not now < expires_at <= now + 600_000:
        raise ValueError('fresh server grant expiry within the ten-minute ceiling is required')
    if read_receipt(root):
        raise ValueError('recover the previous fixture before arming another')
    if key in (state_at(root).get('markers') or {}):
        raise ValueError('request already has a relock marker')
    name = 'hb-' + key
    if os.path.lexists(os.path.join(root, name)):
        raise ValueError('refusing an existing heartbeat path')
    driver_start = process_start(driver_pid)
    if not driver_start:
        raise ValueError('fixture driver is not alive')
    receipt = {'schema': 2, 'key': key, 'uid': os.getuid(), 'token': uuid.uuid4().hex,
               'phase': 'reserved', 'driverPid': driver_pid, 'driverStart': driver_start,
               'expiresAt': expires_at, 'secretState': 'not-submitted', 'grantRevoked': False}
    save_receipt(root, receipt)  # durable before the target path is created
    fd = os.open(os.path.join(root, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, receipt['token'].encode())
        os.fsync(fd)
        info = os.fstat(fd)
        receipt.update(phase='created', dev=info.st_dev, ino=info.st_ino)
        save_receipt(root, receipt)  # durable before any immutable flag
        os.utime(fd, ns=(STALE_NS, STALE_NS))
        set_flags(fd, IMMUTABLE)
        os.fsync(fd)
    finally:
        os.close(fd)
    result = observe(root, receipt)
    if not result['frozen'] or result['ageMs'] <= 5_000:
        raise ValueError('failed to freeze a stale heartbeat')
    return dict(result, armed=True, expiresAt=expires_at)


def record_boundary(root, receipt, driver_pid, request, action):
    if (not receipt or receipt['key'] != request + '.0'
            or receipt['driverPid'] != driver_pid or process_start(driver_pid) != receipt['driverStart']):
        raise ValueError('boundary update requires the exact current driver and request')
    if action == 'begin-secret':
        if receipt['grantRevoked'] or int(time.time() * 1000) >= receipt['expiresAt']:
            raise ValueError('fixture grant has ended')
        if not observe(root, receipt)['frozen']:
            raise ValueError('heartbeat must remain frozen before submission')
        receipt['secretState'] = 'may-be-in-flight'
    else:
        # Called only after the driver receives revoked:true from this exact request's
        # authenticated revoke route. A closed browser is never this confirmation.
        receipt['grantRevoked'] = True
    save_receipt(root, receipt)
    return {'key': receipt['key'], 'submitting': action == 'begin-secret',
            'grantRevoked': receipt['grantRevoked'], 'expiresAt': receipt['expiresAt']}


def receipt_status(receipt):
    if not receipt:
        return {'present': False}
    return {k: receipt[k] for k in ('key', 'expiresAt', 'secretState', 'grantRevoked')} | {'present': True}


def release(root, receipt, driver_pid):
    if not receipt:
        return {'released': True, 'present': False}
    if receipt['driverPid'] != driver_pid and process_start(receipt['driverPid']) == receipt['driverStart']:
        raise ValueError('another live proof driver owns the heartbeat fixture')
    boundary = 'not-submitted' if receipt['secretState'] == 'not-submitted' else \
        ('revoked' if receipt['grantRevoked'] else 'expired' if int(time.time() * 1000) >= receipt['expiresAt'] else None)
    if boundary is None:
        raise ValueError('retaining frozen heartbeat: exact grant revocation or recorded server expiry is required')
    key = receipt['key']
    try:
        fd = checked_file(root, 'hb-' + key)
    except FileNotFoundError:
        fd = None
    if fd is not None:
        try:
            info = os.fstat(fd)
            if receipt['phase'] == 'reserved':
                # A crash before recording the inode cannot have set the flag. Leave any
                # nonimmutable file untouched (including a partial write or a racing file),
                # and retire only our receipt. Never infer ownership of that file.
                if getattr(info, 'st_flags', 0):
                    raise ValueError('incomplete receipt cannot release flagged heartbeat safely')
            elif (info.st_dev, info.st_ino) == (receipt['dev'], receipt['ino']):
                flags = getattr(info, 'st_flags', 0)
                if flags not in (0, IMMUTABLE):
                    raise ValueError('refusing unknown heartbeat flags')
                if flags:
                    set_flags(fd, 0)
                    os.fsync(fd)
                if getattr(os.fstat(fd), 'st_flags', 0) & IMMUTABLE:
                    raise ValueError('heartbeat remains immutable')
            else:
                # The original immutable inode cannot have been replaced until its flag
                # was removed. A native producer may replace it after a crashed release.
                # Leave the replacement completely untouched.
                if getattr(info, 'st_flags', 0) & IMMUTABLE:
                    raise ValueError('unknown immutable replacement at heartbeat path')
        finally:
            os.close(fd)
    os.unlink(os.path.join(root, RECEIPT))
    sync_dir(root)
    return {'released': True, 'present': True, 'key': key, 'boundary': boundary}


def allowed_root(root):
    root = os.path.abspath(root)
    if os.path.realpath(root) != root:
        raise ValueError('refusing symlinked store path')
    if root == PROOF_STORE:
        if pwd.getpwuid(os.getuid()).pw_name != 'instarproof':
            raise ValueError('must run as instarproof, not root or the operator')
    else:
        test = os.environ.get('LOCKED_PROOF_TEST_ROOT')
        tmp = os.path.realpath(tempfile.gettempdir()) + os.sep
        if (not test or root != os.path.realpath(test) or not root.startswith(tmp)
                or not root.endswith('/.instar/desktop-helper/locked')):
            raise ValueError('not the proof store or an explicit disposable test store')
    if os.path.exists(root):
        info = os.lstat(root)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError('proof store must be owned by the caller and not writable by others')
    return root


def main():
    args = sys.argv[1:]
    driver_pid = os.getppid()
    if '--driver-pid' in args:
        index = args.index('--driver-pid')
        driver_pid = int(args[index + 1])
        del args[index:index + 2]
    if driver_pid <= 0 or driver_pid > 2_147_483_647:
        raise ValueError('invalid driver pid')
    if '--execute' not in args:
        raise ValueError('dry run: --execute is required')
    args.remove('--execute')
    if len(args) not in (2, 3, 4) or args[0] not in ('arm', 'observe', 'release', 'receipt', 'begin-secret', 'confirm-revoked'):
        raise ValueError('usage: --execute ACTION STORE [REQUEST_UUID] [SERVER_EXPIRES_AT_MS]')
    action, root = args[:2]
    root = allowed_root(root)
    if not os.path.exists(root) and action in ('release', 'receipt'):
        print(json.dumps({'released': True, 'present': False} if action == 'release' else {'present': False}))
        return
    # No directory creation outside setup: arm requires the real proof store to exist.
    lock_path = os.path.join(root, '.proof-guard-ack.lock')
    lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('invalid fixture lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = read_receipt(root)
        if action == 'arm':
            if len(args) != 4:
                raise ValueError('request UUID and server grant expiry are required to arm')
            result = arm(root, args[2], driver_pid, int(args[3]))
        elif action in ('begin-secret', 'confirm-revoked'):
            result = record_boundary(root, receipt, driver_pid, args[2] if len(args) == 3 else '', action)
        elif action == 'receipt':
            result = receipt_status(receipt)
        elif action == 'observe':
            result = observe(root, receipt)
        else:
            result = release(root, receipt, driver_pid)
        print(json.dumps(result))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit('guard-ack fixture: ' + str(error))
