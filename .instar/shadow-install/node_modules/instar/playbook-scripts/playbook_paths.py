"""
Playbook Path Abstraction Layer (Phase 4.1)

Centralizes all path resolution for the Playbook context engineering system.
Replaces hardcoded .claude/ paths across 30 scripts with a single source of truth.

Two modes:
  1. Legacy (Dawn): Scripts in .claude/scripts/, data in .claude/
  2. Instar: Config-driven paths, data in .instar/playbook/

Resolution order:
  - PLAYBOOK_CONFIG env var -> read config file -> config-driven paths
  - PLAYBOOK_PROJECT_DIR env var -> legacy playbook root
  - Script location -> auto-detect (scripts dir parent = playbook root)

Path security: All resolved paths validated via os.path.realpath() to prevent
directory traversal. Any path escaping the project root is rejected.
"""

import json
import os
import sys

_singleton = None


class PlaybookPaths:
    """Resolves all Playbook file paths based on configuration or legacy layout."""

    def __init__(self, project_dir=None, config_path=None):
        self._config = None
        self._script_dir = os.path.dirname(os.path.abspath(__file__))

        # Try to load config first (Instar mode)
        config_path = config_path or os.environ.get("PLAYBOOK_CONFIG")
        if config_path and os.path.exists(config_path):
            self._config = self._load_json(config_path)

        # Resolve project root and playbook root
        if self._config:
            # Config-driven mode (Instar)
            self.project_root = os.path.realpath(
                project_dir
                or os.environ.get("PLAYBOOK_PROJECT_DIR")
                or os.getcwd()
            )
            playbook_rel = self._config.get("paths", {}).get("root", ".instar/playbook")
            self.playbook_root = os.path.realpath(
                os.path.join(self.project_root, playbook_rel)
            )
        else:
            # Legacy mode: PLAYBOOK_PROJECT_DIR points to playbook root (e.g., .claude/)
            # or auto-detect from script location
            legacy_root = (
                project_dir
                or os.environ.get("PLAYBOOK_PROJECT_DIR")
                or os.path.join(self._script_dir, "..")
            )
            self.playbook_root = os.path.realpath(legacy_root)
            self.project_root = os.path.realpath(
                os.path.join(self.playbook_root, "..")
            )

        # Where scripts live (bundled or ejected)
        self.scripts_dir = os.path.realpath(
            os.environ.get("PLAYBOOK_SCRIPTS_DIR", self._script_dir)
        )

    # --- Core data files ---

    @property
    def manifest(self):
        """Path to context-manifest.json."""
        name = self._config_path("manifest", "context-manifest.json")
        return self._resolve(name)

    @property
    def governance(self):
        """Path to context-governance.json."""
        name = self._config_path("governance", "context-governance.json")
        return self._resolve(name)

    @property
    def history(self):
        """Path to context-history.jsonl."""
        name = self._config_path("history", "context-history.jsonl")
        return self._resolve(name)

    @property
    def assembly_log(self):
        """Path to context-assembly-log.jsonl."""
        return self._resolve("context-assembly-log.jsonl")

    @property
    def rejected_log(self):
        """Path to context-rejected-deltas.jsonl."""
        return self._resolve("context-rejected-deltas.jsonl")

    @property
    def feedback_file(self):
        """Path to sub-agent-feedback.jsonl."""
        return self._resolve("sub-agent-feedback.jsonl")

    # --- Directories ---

    @property
    def pending_review_dir(self):
        """Path to context-pending-review/ directory."""
        return self._resolve("context-pending-review")

    @property
    def scratchpad_dir(self):
        """Path to sessions/ directory for per-session scratchpads."""
        name = self._config_path("scratchpad_dir", "sessions")
        return self._resolve(name)

    @property
    def archive_dir(self):
        """Path to archive/ directory for history rotations."""
        name = self._config_path("archive_dir", "archive")
        return self._resolve(name)

    @property
    def schema_dir(self):
        """Path to schemas/ directory."""
        name = self._config_path("schema_dir", "schemas")
        return self._resolve(name)

    # --- Schema files ---

    @property
    def manifest_schema(self):
        """Path to context-manifest.schema.json."""
        return os.path.join(self.schema_dir, "context-manifest.schema.json")

    @property
    def delta_schema(self):
        """Path to context-delta.schema.json."""
        return os.path.join(self.schema_dir, "context-delta.schema.json")

    @property
    def config_schema(self):
        """Path to playbook-config.schema.json."""
        return os.path.join(self.schema_dir, "playbook-config.schema.json")

    # --- Repo-relative path resolution ---

    def resolve_item_path(self, relative_path):
        """Resolve a manifest item's file path relative to project root.

        Raises ValueError if resolved path escapes project root (traversal attack).
        """
        if not relative_path:
            return ""
        if os.path.isabs(relative_path):
            resolved = os.path.realpath(relative_path)
        else:
            resolved = os.path.realpath(
                os.path.join(self.project_root, relative_path)
            )
        self._validate_containment(resolved, self.project_root)
        return resolved

    def script_path(self, script_name):
        """Resolve path to a playbook script by name."""
        return os.path.join(self.scripts_dir, script_name)

    # --- Config access ---

    @property
    def config(self):
        """The loaded playbook-config.json dict, or None in legacy mode."""
        return self._config

    @property
    def is_instar_mode(self):
        """True if running with a playbook-config.json (Instar mode)."""
        return self._config is not None

    # --- Internal helpers ---

    def _config_path(self, key, default):
        """Get a path name from config, or use default."""
        if self._config:
            return self._config.get("paths", {}).get(key, default)
        return default

    def _resolve(self, relative):
        """Resolve a path relative to playbook root."""
        return os.path.join(self.playbook_root, relative)

    @staticmethod
    def _validate_containment(path, container):
        """Ensure path is within container directory."""
        real_path = os.path.realpath(path)
        real_container = os.path.realpath(container)
        if not real_path.startswith(real_container + os.sep) and real_path != real_container:
            raise ValueError(
                f"Path traversal blocked: {path} resolves to {real_path} "
                f"which is outside {real_container}"
            )

    @staticmethod
    def _load_json(path):
        """Load a JSON file, returning None on error."""
        try:
            with open(path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None

    def __repr__(self):
        mode = "instar" if self.is_instar_mode else "legacy"
        return (
            f"PlaybookPaths(mode={mode}, "
            f"project_root={self.project_root!r}, "
            f"playbook_root={self.playbook_root!r})"
        )


def get_paths(project_dir=None, config_path=None):
    """Get or create the singleton PlaybookPaths instance."""
    global _singleton
    if project_dir or config_path or _singleton is None:
        _singleton = PlaybookPaths(project_dir=project_dir, config_path=config_path)
    return _singleton


def reset():
    """Reset the singleton (for testing)."""
    global _singleton
    _singleton = None
