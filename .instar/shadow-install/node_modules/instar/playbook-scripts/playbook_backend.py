"""
Playbook Backend Abstraction (Phase 4.2)

Provides a unified interface for reading/writing Playbook data files.
Currently implements FilesystemBackend with advisory file locking.
SQLite backend is a future extension point.

The backend handles:
  - Manifest reads/writes (atomic, locked)
  - History append (atomic, append-only)
  - Governance reads (read-only from backend perspective)
  - Scratchpad reads/writes (per-session)
  - Advisory file locking (fcntl.flock) for concurrent access safety

Usage:
    from playbook_backend import get_backend
    backend = get_backend()

    with backend.lock():
        manifest = backend.read_manifest()
        manifest['items'].append(new_item)
        backend.write_manifest(manifest)
"""

import fcntl
import json
import os
import sys
import time
from abc import ABC, abstractmethod
from contextlib import contextmanager

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from atomic_write import atomic_write_json, atomic_append
from playbook_paths import get_paths


class PlaybookBackend(ABC):
    """Abstract base class for Playbook storage backends."""

    @abstractmethod
    def read_manifest(self):
        """Read and return the context manifest as a dict."""

    @abstractmethod
    def write_manifest(self, data):
        """Write the context manifest. Must hold lock."""

    @abstractmethod
    def append_history(self, entry):
        """Append an entry to the history log."""

    @abstractmethod
    def read_history(self, since=None):
        """Read history entries, optionally filtered by timestamp."""

    @abstractmethod
    def read_governance(self):
        """Read the governance policy file."""

    @abstractmethod
    def write_scratchpad(self, session_id, data):
        """Write a session scratchpad."""

    @abstractmethod
    def read_scratchpad(self, session_id):
        """Read a session scratchpad, or None if not found."""

    @abstractmethod
    def acquire_lock(self, timeout_seconds=30):
        """Acquire exclusive write lock. Returns True if acquired."""

    @abstractmethod
    def release_lock(self):
        """Release the write lock."""

    @contextmanager
    def lock(self, timeout_seconds=30):
        """Context manager for locked operations."""
        acquired = self.acquire_lock(timeout_seconds)
        if not acquired:
            raise TimeoutError(
                f"Could not acquire playbook lock within {timeout_seconds}s. "
                f"Another process may be writing. Check for stale locks."
            )
        try:
            yield
        finally:
            self.release_lock()

    def migrate_to(self, target_backend):
        """Migrate all data to a different backend.

        Returns a dict with migration results.
        """
        manifest = self.read_manifest()
        history = self.read_history()
        governance = self.read_governance()

        with target_backend.lock():
            target_backend.write_manifest(manifest)
            for entry in history:
                target_backend.append_history(entry)

        return {
            "items_migrated": len(manifest.get("items", [])),
            "history_entries": len(history),
            "status": "complete",
        }


class FilesystemBackend(PlaybookBackend):
    """File-based backend with advisory locking via fcntl.flock().

    All writes go through atomic_write (temp file + rename) for crash safety.
    Advisory locking prevents concurrent CLI + lifecycle job corruption.
    """

    def __init__(self, paths=None):
        self._paths = paths or get_paths()
        self._lock_path = os.path.join(self._paths.playbook_root, ".lock")
        self._lockfile = None
        self._locked = False

    def read_manifest(self):
        path = self._paths.manifest
        if not os.path.exists(path):
            return {"version": 1, "schema_version": "2.0.0", "items": []}
        with open(path, "r") as f:
            return json.load(f)

    def write_manifest(self, data):
        if not self._locked:
            raise RuntimeError(
                "Must acquire lock before writing manifest. "
                "Use 'with backend.lock(): ...' or call acquire_lock() first."
            )
        atomic_write_json(self._paths.manifest, data)

    def append_history(self, entry):
        line = json.dumps(entry, separators=(",", ":"), ensure_ascii=True)
        atomic_append(self._paths.history, line)

    def read_history(self, since=None):
        path = self._paths.history
        if not os.path.exists(path):
            return []
        entries = []
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if since and entry.get("timestamp", "") < since:
                    continue
                entries.append(entry)
        return entries

    def read_governance(self):
        path = self._paths.governance
        if not os.path.exists(path):
            return {}
        with open(path, "r") as f:
            return json.load(f)

    def write_scratchpad(self, session_id, data):
        scratchpad_dir = os.path.join(self._paths.scratchpad_dir, session_id)
        os.makedirs(scratchpad_dir, exist_ok=True)
        path = os.path.join(scratchpad_dir, "scratchpad.json")
        atomic_write_json(path, data)

    def read_scratchpad(self, session_id):
        path = os.path.join(self._paths.scratchpad_dir, session_id, "scratchpad.json")
        if not os.path.exists(path):
            return None
        with open(path, "r") as f:
            return json.load(f)

    def acquire_lock(self, timeout_seconds=30):
        if self._locked:
            return True

        os.makedirs(os.path.dirname(os.path.abspath(self._lock_path)), exist_ok=True)
        self._lockfile = open(self._lock_path, "w")

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            try:
                fcntl.flock(self._lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
                # Write PID for stale lock detection
                self._lockfile.write(json.dumps({
                    "pid": os.getpid(),
                    "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }))
                self._lockfile.flush()
                self._locked = True
                return True
            except (BlockingIOError, OSError):
                time.sleep(0.1)

        # Timeout — clean up
        self._lockfile.close()
        self._lockfile = None
        return False

    def release_lock(self):
        if not self._locked or not self._lockfile:
            return
        try:
            fcntl.flock(self._lockfile, fcntl.LOCK_UN)
            self._lockfile.close()
        except OSError:
            pass
        self._lockfile = None
        self._locked = False

    @property
    def is_locked(self):
        """Check if this backend instance currently holds the lock."""
        return self._locked

    def __repr__(self):
        return f"FilesystemBackend(root={self._paths.playbook_root!r}, locked={self._locked})"


# Module-level singleton
_backend_singleton = None


def get_backend(paths=None):
    """Get or create the singleton FilesystemBackend."""
    global _backend_singleton
    if paths or _backend_singleton is None:
        _backend_singleton = FilesystemBackend(paths=paths)
    return _backend_singleton


def reset():
    """Reset the backend singleton (for testing)."""
    global _backend_singleton
    if _backend_singleton and _backend_singleton._locked:
        _backend_singleton.release_lock()
    _backend_singleton = None
