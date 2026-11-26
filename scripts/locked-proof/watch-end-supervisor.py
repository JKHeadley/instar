#!/usr/bin/env python3
"""Proof-account-only bounded recovery for the watch-end fault. No native policy changes.

arm receives a JSON plan on stdin, creates a private durable receipt and forks a
monitor; ready is returned only after the monitor has fsynced its ACK. Commands
serialize with recovery through a nonblocking lock. Test mode is confined to a
private temporary root and nonce-tagged inert Python workers; it never loads Mac APIs.
"""
import ctypes
import fcntl
import json
import os
import pathlib
import plistlib
import pwd
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

PROOF = '/Users/instarproof/.instar/desktop-helper/locked'
KEY = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.\d+$')
TERMINAL = ('recovered', 'recovery-failed')


def now():
    return int(time.time() * 1000)


def run(args, text=None, timeout=1):
    return subprocess.run(args, input=text, text=True, capture_output=True, timeout=timeout)


def atomic(root, name, value):
    fd, tmp = tempfile.mkstemp(prefix='.write-', dir=root)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, os.path.join(root, name))
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read(root, name):
    fd = os.open(os.path.join(root, name), os.O_RDONLY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    # An atomic replace can unlink this already-open inode before fstat.
    # Zero links is safe for this read; multiple links remain forbidden.
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink > 1:
        os.close(fd)
        raise ValueError('unsafe receipt file')
    with os.fdopen(fd) as stream:
        return json.load(stream)


def root_check(value, create=False):
    root = os.path.abspath(value)
    if os.path.realpath(root) != root:
        raise ValueError('symlinked recovery directory')
    test = os.environ.get('LOCKED_PROOF_WATCH_TEST_ROOT')
    testing = bool(test and root == os.path.realpath(test) and root.startswith(os.path.realpath(tempfile.gettempdir()) + os.sep))
    if not testing and (root != PROOF + '/.proof-watch-end' or pwd.getpwuid(os.getuid()).pw_name != 'instarproof'):
        raise ValueError('not the dedicated proof account recovery directory')
    if create:
        os.makedirs(root, mode=0o700, exist_ok=True)
    info = os.lstat(root)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('recovery directory must be private and owned')
    return root, testing


def process(pid, helper=None):
    if type(pid) is not int or pid <= 1:
        raise ValueError('invalid process identity')
    result = run(['/bin/ps', '-p', str(pid), '-o', 'uid=,stat=,lstart=,command='])
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return None
    match = re.fullmatch(r'\s*(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})\s+(.*)\s*', result.stdout)
    if result.returncode or result.stderr.strip() or not match:
        raise ValueError('process observation unavailable')
    start = match[3]
    if helper:
        observed = run([helper, 'state-op'], json.dumps({'root': PROOF, 'op': 'process-start', 'pid': pid}))
        start = json.loads(observed.stdout).get('start') if observed.returncode == 0 else None
        if not isinstance(start, str) or not re.fullmatch(r'\d+\.\d+', start):
            raise ValueError('native process start unavailable')
    return {'pid': pid, 'uid': int(match[1]), 'stat': match[2], 'start': start, 'command': match[4].strip()}


def same(expected, actual):
    return actual is not None and all(actual.get(k) == expected.get(k) for k in ('pid', 'uid', 'start', 'command'))


def checked_process(receipt, target):
    expected = receipt[target]
    current = process(expected['pid'], receipt.get('helper'))
    if not current or current['stat'].startswith('Z'):
        return None
    if not same(expected, current):
        raise ValueError(target + ' identity changed')
    return current


def cg_context():
    """The same boot/login/on-console fields used by the native guard, no IORegistry inference."""
    if sys.platform != 'darwin':
        raise ValueError('Mac context unavailable')
    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cg.CGSessionCopyCurrentDictionary.argtypes = []
    cg.CGSessionCopyCurrentDictionary.restype = ctypes.c_void_p
    cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_ulong, ctypes.c_void_p]
    cf.CFPropertyListCreateData.restype = ctypes.c_void_p
    cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
    cf.CFDataGetLength.restype = ctypes.c_long
    cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
    cf.CFDataGetBytePtr.restype = ctypes.POINTER(ctypes.c_ubyte)
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cf.CFRelease.restype = None
    dictionary = cg.CGSessionCopyCurrentDictionary()
    if not dictionary:
        raise ValueError('login context unreadable')
    data = None
    try:
        data = cf.CFPropertyListCreateData(None, dictionary, 100, 0, None)
        if not data:
            raise ValueError('login context unencodable')
        length = cf.CFDataGetLength(data)
        if not 0 < length < 65536:
            raise ValueError('login context size invalid')
        state = plistlib.loads(ctypes.string_at(cf.CFDataGetBytePtr(data), length))
    finally:
        if data:
            cf.CFRelease(data)
        cf.CFRelease(dictionary)
    boot = run(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'])
    if boot.returncode or not boot.stdout.strip():
        raise ValueError('boot context unreadable')
    session = state.get('CGSSessionUniqueSessionUUID')
    if not isinstance(session, str) or not session or type(state.get('kCGSSessionOnConsoleKey')) is not bool:
        raise ValueError('login identity unreadable')
    return {'boot': boot.stdout.strip(), 'login': session, 'uid': state.get('kCGSSessionUserIDKey'),
            'onConsole': state['kCGSSessionOnConsoleKey'], 'locked': state.get('CGSSessionScreenIsLocked') is True}


def context(root, testing):
    return read(root, 'test-context.json') if testing else cg_context()


def same_console(expected, observed):
    return observed.get('onConsole') is True and observed.get('uid') == os.getuid() and all(
        observed.get(k) == expected.get(k) for k in ('boot', 'login', 'uid'))


def lock_context(root, testing, receipt=None):
    receipt = receipt if receipt is not None else read(root, 'receipt.json')
    current = context(root, testing)
    if not same_console(receipt['context'], current):
        raise ValueError('proof boot/login/console changed or unknown; no lock attempted')
    if testing:
        atomic(root, 'test-lock.json', {'at': now(), 'context': current})
        return {'locked': True, 'testOnly': True}
    if current['locked']:
        return {'locked': True, 'alreadyLocked': True}
    # No keystroke fallback. The function runs inside the proof user's original bootstrap.
    login = ctypes.CDLL('/System/Library/PrivateFrameworks/login.framework/Versions/Current/login')
    lock = login.SACLockScreenImmediate
    lock.argtypes, lock.restype = [], None
    lock()
    for _ in range(10):
        current = cg_context()
        if not same_console(receipt['context'], current):
            raise ValueError('context changed after lock attempt')
        if current['locked']:
            return {'locked': True}
        time.sleep(.1)
    raise ValueError('proof session lock not confirmed')


def serialized(root):
    fd = os.open(os.path.join(root, 'operation.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('unsafe operation lock')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def resume(receipt, target):
    current = checked_process(receipt, target)
    if current is None:
        return {'gone': True}
    os.kill(current['pid'], signal.SIGCONT)
    for _ in range(5):
        seen = checked_process(receipt, target)
        if seen is None or not seen['stat'].startswith('T'):
            return {'continued': True, 'gone': seen is None, 'identity': seen}
        time.sleep(.05)
    raise ValueError(target + ' did not resume')


def recover(root, testing, reason, saved):
    problems = [reason] if 'operation-lock unavailable' in reason else []
    receipt = json.loads(json.dumps(saved))
    try:
        disk = read(root, 'receipt.json')
        if any(disk.get(k) != saved.get(k) for k in ('guard', 'server', 'driver', 'context', 'helper', 'key', 'nonce')):
            problems.append('armed recovery identity/context receipt changed; retained original plan')
    except Exception as error:
        problems.append('receipt unreadable: ' + str(error))
    receipt.update(state='recovering', recoveryReason=reason, recoveryStartedAt=now())
    try:
        atomic(root, 'receipt.json', receipt)
    except Exception as error:
        problems.append('recovery-start persistence: ' + str(error))
    results = {}
    for target in ('guard', 'server'):
        try:
            results[target] = resume(receipt, target)
        except Exception as error:
            problems.append(target + ': ' + str(error))
    try:
        result = run([sys.executable, os.path.realpath(__file__), 'lock', root], json.dumps(receipt), timeout=4)
        if result.returncode:
            raise ValueError(result.stderr.strip() or 'lock child failed')
        results['lock'] = json.loads(result.stdout)
        if results['lock'].get('locked') is not True:
            raise ValueError('lock unconfirmed')
    except Exception as error:
        problems.append('lock: ' + str(error))
    receipt.update(state='recovery-failed' if problems else 'recovered', results=results,
                   recoveryProblems=problems, recoveredAt=now())
    atomic(root, 'receipt.json', receipt)
    return receipt


def monitor(root, testing, duration):
    # Monotonic bound is fixed at arm and cannot be extended by wall-clock rollback.
    end = time.monotonic() + duration
    receipt = read(root, 'receipt.json')
    receipt.update(state='armed', supervisorPid=os.getpid(),
                   supervisor=process(os.getpid(), receipt.get('helper')), readyAt=now())
    atomic(root, 'receipt.json', receipt)
    saved = dict(receipt)
    while True:
        reason = None
        try:
            receipt = read(root, 'receipt.json')
            if receipt['state'] in TERMINAL:
                return
            if receipt.get('finishRequested'):
                reason = 'finish-requested'
            elif time.monotonic() >= end:
                reason = 'deadline'
            else:
                driver = process(receipt['driver']['pid'], receipt.get('helper'))
                if not same(receipt['driver'], driver) or driver['stat'].startswith('Z'):
                    reason = 'driver-ended'
        except Exception as error:
            reason = 'monitor-observation-failed: ' + str(error)
        if reason:
            try:
                fd = serialized(root)
            except Exception as error:
                # Broken bookkeeping must not strand the retained exact processes.
                recover(root, testing, reason + '; operation-lock unavailable: ' + str(error), saved)
                return
            if fd is not None:
                try:
                    recover(root, testing, reason, saved)
                finally:
                    os.close(fd)
                return
        time.sleep(.1)


def arm(root, testing, plan, lock_fd):
    prior = None
    try:
        prior = read(root, 'receipt.json')
    except FileNotFoundError:
        pass
    if prior is not None:
        raise ValueError('existing recovery receipt must be reviewed and archived before another run')
    key = plan.get('key', '')
    if not KEY.fullmatch(key):
        raise ValueError('invalid duty key')
    helper = None if testing else os.path.realpath(plan.get('helper', ''))
    if not testing and (not helper.startswith('/Users/instarproof/.instar/') or os.path.basename(helper) != 'instar-desktop-host'
                        or not stat.S_ISREG(os.stat(helper).st_mode) or os.stat(helper).st_uid != os.getuid()):
        raise ValueError('not the proof user retained helper')
    identities = {target: process(plan.get(target + 'Pid'), helper) for target in ('guard', 'server', 'driver')}
    if any(value is None for value in identities.values()):
        raise ValueError('a required process is absent')
    nonce = plan.get('testNonce')
    for target in ('guard', 'server'):
        identity = identities[target]
        if identity['uid'] != os.getuid() or identity['stat'].startswith(('T', 'Z')):
            raise ValueError('target is not a running owned process')
        args = identity['command'].split()
        if testing:
            if (not isinstance(nonce, str) or not re.fullmatch(r'[a-f0-9]{32}', nonce)
                    or len(args) != 4 or args[0] != process(os.getpid())['command'].split()[0]
                    or args[1:] != [os.path.realpath(__file__), 'test-worker', 'watch-end-test:' + nonce]):
                raise ValueError('test target is not a nonce-tagged inert worker')
        elif target == 'guard':
            if args != [helper, 'relock-guard', PROOF, key] or identity['start'] != plan.get('guardStart'):
                raise ValueError('guard command/start does not match duty')
        elif not all(x in args for x in ('server', 'start', '--foreground', '--dir', '/Users/instarproof/.instar/agents/locked-proof')):
            raise ValueError('not the dedicated foreground proof server')
    current = context(root, testing)
    if not testing and (current.get('boot') != plan.get('bootSession') or current.get('login') != plan.get('loginSession')):
        raise ValueError('duty does not belong to this boot/login session')
    if not same_console(current, current):
        raise ValueError('proof user is not positively on console')
    watch_start = plan.get('watchStart')
    if type(watch_start) is not int or not 0 <= now() - watch_start < 80_000:
        raise ValueError('watch is not fresh enough for a bounded human step')
    deadline = watch_start + 138_000
    if testing:
        duration = plan.get('testDurationMs')
        if type(duration) is not int or not 100 <= duration <= 5_000:
            raise ValueError('invalid bounded test duration')
        deadline = now() + duration
    receipt = dict(identities, schema=1, nonce=uuid.uuid4().hex, key=key, helper=helper, context=current,
                   watchStart=watch_start, deadlineAt=deadline, state='preparing', createdAt=now())
    atomic(root, 'receipt.json', receipt)
    duration = max(0, (deadline - now()) / 1000)
    pid = os.fork()
    if pid == 0:
        os.close(lock_fd)  # Do not retain the launcher's flock through fork.
        os.setsid()
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        if null > 2:
            os.close(null)
        try:
            monitor(root, testing, duration)
        except Exception as error:
            try:
                receipt = read(root, 'receipt.json')
                receipt.update(state='recovery-failed', recoveryProblems=['monitor failed: ' + str(error)])
                atomic(root, 'receipt.json', receipt)
            finally:
                os._exit(1)
        os._exit(0)
    until = time.monotonic() + 3
    while time.monotonic() < until:
        receipt = read(root, 'receipt.json')
        if receipt.get('state') == 'armed' and receipt.get('supervisorPid') == pid:
            return receipt
        time.sleep(.02)
    raise ValueError('supervisor ready ACK not confirmed; do not stop anything')


def probe_store_lock(file):
    fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('unsafe state lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(fd)


def command(root, testing, action, driver_pid=None):
    receipt = read(root, 'receipt.json')
    if action == 'status':
        return receipt
    if action == 'archive':
        if receipt['state'] != 'recovered':
            raise ValueError('only confirmed recovered receipts may be archived')
        current = context(root, testing)
        if not same_console(receipt['context'], current) or (not testing and not current['locked']):
            raise ValueError('proof context is not confirmed safely locked for archive')
        archive = 'receipt-' + receipt['nonce'] + '.json'
        atomic(root, archive, receipt)
        os.unlink(os.path.join(root, 'receipt.json'))
        return {'archived': archive}
    if receipt['state'] not in TERMINAL and driver_pid != receipt['driver']['pid']:
        owner = process(receipt['driver']['pid'], receipt.get('helper'))
        if same(receipt['driver'], owner):
            raise ValueError('another live driver owns this fixture')
    if action == 'finish':
        if receipt['state'] not in TERMINAL:
            receipt['finishRequested'] = True
            atomic(root, 'receipt.json', receipt)
        return receipt
    if receipt['state'] != 'armed' or now() >= receipt['deadlineAt']:
        raise ValueError('supervisor is not armed within deadline')
    if action == 'freeze':
        supervisor = checked_process(receipt, 'supervisor')
        if supervisor is None or supervisor['stat'].startswith('T'):
            raise ValueError('independent supervisor is not running; do not stop anything')
        for target in ('server', 'guard'):
            current = checked_process(receipt, target)
            if current is None:
                raise ValueError('target exited before freeze')
            os.kill(current['pid'], signal.SIGSTOP)
            time.sleep(.1 if testing else .5)
            frozen = checked_process(receipt, target)
            if frozen is None or not frozen['stat'].startswith('T'):
                raise ValueError(target + ' did not remain stopped')
        # Never wait for a lock held by a process this fixture has stopped.
        probe_store_lock(os.path.join(root, 'test-state.lock') if testing else PROOF + '/state.lock')
        receipt['frozenAt'] = now()
        atomic(root, 'receipt.json', receipt)
        return {'frozen': True, 'at': receipt['frozenAt'], 'nonce': receipt['nonce']}
    if action in ('resume-guard', 'resume-server'):
        target = action[7:]
        result = resume(receipt, target)
        receipt[target + 'ResumedAt'] = now()
        atomic(root, 'receipt.json', receipt)
        return dict(result, at=receipt[target + 'ResumedAt'])
    raise ValueError('unknown action')


def main():
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == 'test-worker' and re.fullmatch(r'watch-end-test:[a-f0-9]{32}', args[1]):
        print('ready', flush=True)
        time.sleep(30)
        return
    driver_pid = os.getppid()
    if '--driver-pid' in args:
        index = args.index('--driver-pid')
        driver_pid = int(args[index + 1])
        del args[index:index + 2]
    if len(args) != 2:
        raise ValueError('usage: [--driver-pid PID] arm|status|freeze|resume-guard|resume-server|finish|archive|lock RECOVERY_DIR')
    action, value = args
    root, testing = root_check(value, create=action == 'arm')
    if action == 'lock':
        print(json.dumps(lock_context(root, testing, json.load(sys.stdin))))
        return
    if action == 'status':
        print(json.dumps(command(root, testing, action)))
        return
    fd = serialized(root)
    if fd is None:
        raise ValueError('recovery operation busy; do not repeat a mutation blindly')
    try:
        result = arm(root, testing, json.load(sys.stdin), fd) if action == 'arm' else command(root, testing, action, driver_pid)
        print(json.dumps(result))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit('watch-end supervisor: ' + str(error))
