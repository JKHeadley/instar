#!/usr/bin/env python3
"""Descriptor-relative filesystem operations for opt-in job transfer.

Never follows a symlink in a bundle-controlled path, including parent components.
The Node caller validates path grammar and bundle size before invoking this helper.
"""
import hashlib
import base64
import time
import json
import os
import re
import stat
import sys

O_DIR = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
O_FILE = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
SECRET_SEGMENT = re.compile(r'^(?:\.env(?:\..*)?|config(?:\.json)?|auth|secrets?|tokens?|credentials?|\.instar)$', re.I)


def parent_fd(root, relative, create=False):
    parts = relative.split('/')
    if not parts or any(p in ('', '.', '..') for p in parts):
        raise ValueError('unsafe path')
    fd = os.open(root, O_DIR)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, O_DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except Exception:
        os.close(fd)
        raise


def read_at(fd, leaf):
    child = os.open(leaf, O_FILE, dir_fd=fd)
    try:
        mode = os.fstat(child).st_mode
        if not stat.S_ISREG(mode):
            raise ValueError('not a regular file')
        data = os.read(child, 256 * 1024 + 1)
        if len(data) > 256 * 1024:
            raise ValueError('file too large')
        return data
    finally:
        os.close(child)


def read(root, relative):
    fd, leaf = parent_fd(root, relative)
    try:
        return read_at(fd, leaf)
    finally:
        os.close(fd)


def write(root, relative, data, expected_old):
    fd, leaf = parent_fd(root, relative, create=True)
    try:
        try:
            old = read_at(fd, leaf)
        except FileNotFoundError:
            old = None
        if old is not None and (expected_old is None or hashlib.sha256(old).hexdigest() != expected_old):
            if old == data:
                return {'kind': 'same', 'old': ''}
            raise ValueError('local-file-conflict')
        if old == data:
            return {'kind': 'same', 'old': ''}
        temp = '.job-portable-%d-%s' % (os.getpid(), os.urandom(8).hex())
        try:
            child = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600, dir_fd=fd)
            try:
                view = memoryview(data)
                while view:
                    written = os.write(child, view)
                    if written <= 0:
                        raise OSError('short write')
                    view = view[written:]
                os.fsync(child)
                if os.fstat(child).st_size != len(data):
                    raise OSError('written length mismatch')
            finally:
                os.close(child)
            try:
                current = read_at(fd, leaf)
            except FileNotFoundError:
                current = None
            if current != old:
                raise ValueError('destination-changed')
            os.rename(temp, leaf, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass
        return {'kind': 'created' if old is None else 'updated', 'old': (old or b'').hex()}
    finally:
        os.close(fd)


def remove_if_hash(root, relative, expected):
    fd, leaf = parent_fd(root, relative)
    try:
        child = os.open(leaf, O_FILE, dir_fd=fd)
        try:
            if not stat.S_ISREG(os.fstat(child).st_mode):
                raise ValueError('not regular')
            content = os.read(child, 256 * 1024 + 1)
        finally:
            os.close(child)
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError('changed')
        os.unlink(leaf, dir_fd=fd)
        os.fsync(fd)
    finally:
        os.close(fd)



def quarantine(root, source, target, expected):
    source_fd, source_leaf = parent_fd(root, source)
    try:
        target_fd, target_leaf = parent_fd(root, target, create=True)
        try:
            try:
                data = read_at(source_fd, source_leaf)
            except FileNotFoundError:
                print('absent')
                return
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError('manifest-modified-locally')
            try:
                os.stat(target_leaf, dir_fd=target_fd, follow_symlinks=False)
                raise ValueError('quarantine-collision')
            except FileNotFoundError:
                pass
            os.rename(source_leaf, target_leaf, src_dir_fd=source_fd, dst_dir_fd=target_fd)
            os.fsync(source_fd)
            os.fsync(target_fd)
            print('moved')
        finally:
            os.close(target_fd)
    finally:
        os.close(source_fd)


def list_directory(root, relative):
    fd, leaf = parent_fd(root, relative)
    try:
        child = os.open(leaf, O_DIR, dir_fd=fd)
        try:
            rows = []
            for name in sorted(os.listdir(child)):
                info = os.stat(name, dir_fd=child, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode):
                    kind = 'file'
                elif stat.S_ISDIR(info.st_mode):
                    kind = 'dir'
                else:
                    raise ValueError('symlink-refused-or-special-entry')
                rows.append({'name': name, 'kind': kind})
            print(json.dumps(rows))
        finally:
            os.close(child)
    finally:
        os.close(fd)


def collect(root, dependencies):
    started = time.monotonic()
    rows = []
    def walk(relative, depth):
        if time.monotonic() - started > 1.5:
            raise TimeoutError('collection-budget-exceeded')
        if depth > 12 or len(rows) >= 64:
            raise ValueError('dependency-limit')
        fd, leaf = parent_fd(root, relative)
        try:
            info = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                data = read_at(fd, leaf)
                rows.append({'path': relative, 'sha256': hashlib.sha256(data).hexdigest(),
                             'content': base64.b64encode(data).decode('ascii')})
                return
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError('symlink-refused-or-special-entry')
            child = os.open(leaf, O_DIR, dir_fd=fd)
            try:
                names = sorted(os.listdir(child))
                if not names:
                    raise ValueError('empty-dependency-directory')
            finally:
                os.close(child)
        finally:
            os.close(fd)
        for name in names:
            child_path = relative + '/' + name
            if name in ('', '.', '..') or '/' in name or '\\' in name or SECRET_SEGMENT.match(name) or len(child_path) > 256:
                raise ValueError('invalid-entry')
            walk(child_path, depth + 1)
    for dependency in dependencies:
        walk(dependency, 0)
    print(json.dumps(rows, separators=(',', ':')))


def verify_files(root, expected):
    started = time.monotonic()
    if len(expected) > 64:
        raise ValueError('verify-limit')
    for relative, digest in expected.items():
        if time.monotonic() - started > 1.5:
            raise TimeoutError('verify-budget-exceeded')
        data = read(root, relative)
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('imported-file-changed')
    print('verified')

def main():
    mode, root, relative = sys.argv[1:4]
    if mode == 'read':
        sys.stdout.buffer.write(read(root, relative))
    elif mode == 'verify':
        verify_files(root, json.loads(sys.stdin.read()))
    elif mode == 'collect':
        collect(root, json.loads(sys.stdin.read()))
    elif mode == 'list':
        list_directory(root, relative)
    elif mode == 'write':
        value = json.loads(sys.stdin.read())
        data = bytes.fromhex(value['content'])
        print(json.dumps(write(root, relative, data, value.get('expectedOld'))))
    elif mode == 'remove':
        remove_if_hash(root, relative, sys.argv[4])
    elif mode == 'quarantine':
        quarantine(root, relative, sys.argv[4], sys.argv[5])
    else:
        raise ValueError('unsupported operation')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('job-portable-fs: ' + str(exc), file=sys.stderr)
        sys.exit(1)
