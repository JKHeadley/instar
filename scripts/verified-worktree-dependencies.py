#!/usr/bin/python3
"""Install a pinned APFS dependency snapshot in a new, private checkout."""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

COPYFILE_CLONE_FORCE = 1 << 25
RENAME_EXCL = 4
INSTALL_INPUTS = (
    'pnpm-workspace.yaml', 'site/package.json',
    'scripts/fix-better-sqlite3.cjs', 'scripts/resolve-node-binary.cjs',
)
UNRECOGNIZED_INPUTS = (
    '.npmrc', 'site/.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'patches',
)


class StoreMiss(Exception):
    """The store is inapplicable and no checkout path was changed."""


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def regular_file(path):
    return path.is_file() and path.resolve(strict=True) == path


def recipe(checkout):
    files = [checkout / name for name in ('package.json', 'pnpm-lock.yaml', *INSTALL_INPUTS)]
    if not all(regular_file(path) for path in files):
        raise StoreMiss('checkout install inputs are unavailable')
    if any(os.path.lexists(checkout / name) for name in UNRECOGNIZED_INPUTS):
        raise StoreMiss('checkout has additional install configuration')
    manifest = json.loads(files[0].read_text())
    manifest.pop('version', None)
    return {
        'manifest': manifest,
        'lockSha256': digest(files[1]),
        'inputs': {str(path.relative_to(checkout)): digest(path) for path in files[2:]},
    }


def dependency_graph(root):
    device = root.stat().st_dev
    nodes = {}
    def fail(error):
        raise error
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        for name in dirs + files:
            path = Path(directory) / name
            info = path.lstat()
            if info.st_dev != device:
                raise ValueError('mounted descendant in dependency graph')
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                link = os.readlink(path)
                if Path(link).is_absolute() or root not in path.resolve(strict=True).parents:
                    raise ValueError('dependency graph has a nonrelocatable link')
                item = ['link', link]
            elif stat.S_ISDIR(info.st_mode):
                item = ['directory', mode]
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                item = ['file', mode, digest(path)]
            else:
                raise ValueError('unsupported dependency graph entry')
            nodes[str(path.relative_to(root))] = item
    return nodes


def copy_graph(seed, graph, staging):
    darwin = ctypes.CDLL(None, use_errno=True)
    darwin.copyfile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32]
    darwin.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    for relative, (kind, *details) in sorted(graph.items(), key=lambda item: item[0].count('/')):
        source, target = seed / relative, staging / relative
        if kind == 'directory':
            target.mkdir(mode=0o700)
        elif kind == 'link':
            target.symlink_to(details[0])
        else:
            if darwin.copyfile(os.fsencode(source), os.fsencode(target), None, COPYFILE_CLONE_FORCE) != 0:
                raise OSError(ctypes.get_errno(), 'forced dependency clone failed')
            if source.stat().st_ino == target.stat().st_ino:
                raise ValueError('dependency file identity was shared')
    for relative, (kind, *details) in graph.items():
        if kind == 'directory':
            (staging / relative).chmod(details[0])
    if dependency_graph(staging) != graph:
        raise ValueError('staged dependency graph does not match its receipt')
    return darwin


def provision(checkout, store, node):
    if checkout.resolve(strict=True) != checkout or store.resolve(strict=True) != store:
        raise ValueError('checkout or store path is not canonical')
    target = checkout / 'node_modules'
    if os.path.lexists(target):
        raise ValueError('checkout already has a dependency path')
    inputs = recipe(checkout)
    runtime = subprocess.check_output(
        [str(node), '-p', '[process.platform, process.arch, process.version, process.versions.modules].join("-")'],
        text=True, timeout=10,
    ).strip()
    key = f'{inputs["lockSha256"]}-{runtime}'
    config = json.loads((store.parents[1] / 'config.json').read_text())
    pin = config.get('worktree', {}).get('verifiedDependencyEntries', {}).get(key)
    if not isinstance(pin, str):
        raise StoreMiss('there is no pinned recipe for this lock and runtime')
    entry = store / 'verified-seeds' / key
    receipt = entry / 'receipt.json'
    seed = entry / 'node_modules'
    lock_path = store / 'verified-seeds' / 'publication.lock'
    with lock_path.open('rb') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise StoreMiss('dependency publisher is active') from error
        if not regular_file(receipt) or digest(receipt) != pin:
            raise ValueError('dependency receipt does not match its pin')
        proof = json.loads(receipt.read_text())
        if proof['recipe'] != inputs or proof['runtime'] != runtime:
            raise StoreMiss('the pinned recipe does not match this checkout')
        if seed.resolve(strict=True) != seed or seed.stat().st_dev != checkout.stat().st_dev:
            raise StoreMiss('seed is unavailable on the checkout volume')
        graph = dependency_graph(seed)
        if graph != proof['graph']:
            raise ValueError('seed graph does not match its receipt')
        staging = Path(tempfile.mkdtemp(prefix='.instar-dependencies-', dir=checkout))
        darwin = copy_graph(seed, graph, staging)
        if darwin.renamex_np(os.fsencode(staging), os.fsencode(target), RENAME_EXCL) != 0:
            raise OSError(ctypes.get_errno(), 'private dependency publication failed')


if __name__ == '__main__':
    try:
        provision(*(Path(argument) for argument in sys.argv[1:]))
    except StoreMiss as error:
        print(error, file=sys.stderr)
        sys.exit(3)
