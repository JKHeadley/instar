# v0.23.11 — Deeper Native Module Self-Recovery

## What Changed

The pre-flight SQLite binding check now exercises the native layer more thoroughly. Previously it only tested that the module could be imported, but some version mismatches cause runtime crashes (C++ mutex errors) rather than import failures. Now the check opens an in-memory database and runs a pragma, catching these deeper incompatibilities before the server starts.

The rebuild fallback path is also now shadow-install-aware — it tries rebuilding in the shadow install's node_modules before falling back to global. This ensures agents running via shadow installs (the standard deployment) get their native modules rebuilt correctly.

Combined with the v0.23.8 zombie session reaper and v0.23.10 ESM boot wrapper fix, agents should now self-recover from the most common crash patterns without manual intervention.

## What to Tell Your User

- **Self-healing native modules**: "If your Node.js version changes, I can now detect and fix the incompatibility automatically on startup. No more manual rebuilds needed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Deeper native binding check | Automatic on server startup |
| Shadow-install-aware rebuild | Automatic fallback during rebuild |
| Mutex crash detection | Automatic — catches previously undetectable crashes |
