#!/usr/bin/env python3
"""
Atomic file writes with SHA-256 checksum verification.

Part of Playbook Phase 1 pre-work (context-engineering-integration spec).
Ensures file writes are all-or-nothing: partial writes from crashes
are impossible because we write to a temp file first, then atomically
rename. The checksum allows readers to verify integrity.

Usage as library:
    from atomic_write import atomic_write, verify_checksum

Usage as CLI:
    python3 .claude/scripts/atomic_write.py write <path> < content
    python3 .claude/scripts/atomic_write.py verify <path>
"""

import hashlib
import json
import os
import sys
import tempfile


def compute_checksum(content):
    if isinstance(content, str):
        content = content.encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def atomic_write(file_path, content, *, fsync=True):
    if isinstance(content, str):
        content = content.encode("utf-8")

    checksum = compute_checksum(content)
    dir_path = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(dir_path, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(dir=dir_path, prefix=".atomic_")
    try:
        os.write(fd, content)
        if fsync:
            os.fsync(fd)
        os.close(fd)
        os.rename(tmp_path, file_path)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

    return checksum


def atomic_write_json(file_path, obj, *, canonical=False, fsync=True):
    if canonical:
        content = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    else:
        content = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    return atomic_write(file_path, content, fsync=fsync)


def verify_checksum(file_path, expected_checksum):
    try:
        with open(file_path, "rb") as f:
            content = f.read()
        actual = compute_checksum(content)
        return actual == expected_checksum
    except (FileNotFoundError, PermissionError):
        return False


def atomic_append(file_path, line, *, fsync=True):
    if isinstance(line, str):
        line_bytes = line.encode("utf-8")
    else:
        line_bytes = line

    if not line_bytes.endswith(b"\n"):
        line_bytes += b"\n"

    checksum = compute_checksum(line_bytes.rstrip(b"\n"))
    dir_path = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(dir_path, exist_ok=True)

    fd = os.open(file_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line_bytes)
        if fsync:
            os.fsync(fd)
    finally:
        os.close(fd)

    return checksum


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "write":
        if len(sys.argv) < 3:
            print("Usage: atomic_write.py write <path> < content", file=sys.stderr)
            sys.exit(1)
        content = sys.stdin.buffer.read()
        checksum = atomic_write(sys.argv[2], content)
        print(f"Written: {sys.argv[2]} (sha256:{checksum})")

    elif cmd == "verify":
        if len(sys.argv) < 3:
            print("Usage: atomic_write.py verify <path>", file=sys.stderr)
            sys.exit(1)
        with open(sys.argv[2], "rb") as f:
            content = f.read()
        print(f"sha256:{compute_checksum(content)}")

    elif cmd == "checksum":
        content = sys.stdin.buffer.read()
        print(f"sha256:{compute_checksum(content)}")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
