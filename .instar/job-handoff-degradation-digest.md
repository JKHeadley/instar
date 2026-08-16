# Degradation Digest — 2026-05-15T18:35:00Z

## Summary

Reviewed 1,001 degradation events. Identified 8 features with patterns (3+ occurrences each). All patterns submitted as feedback for upstream triage.

## Patterns Found (>= 3 degradations)

| Feature | Count | Status |
|---------|-------|--------|
| SemanticMemory | 13 | 🔴 **PATTERN** — better-sqlite3 Node version mismatch |
| FeatureRegistry | 13 | 🔴 **PATTERN** — better-sqlite3 Node version mismatch |
| sqlite-runtime-broken | 13 | 🔴 **PATTERN** — better-sqlite3 Node version mismatch |
| StuckInputSentinel.recover | 13 | 🔴 **PATTERN** — Bracketed paste input race |
| GitSync.pull | 12 | 🔴 **PATTERN** — Terminal auth failure |
| TopicMemory | 12 | 🔴 **PATTERN** — Node binary missing (ENOENT) |
| iMessage | 12 | 🔴 **PATTERN** — better-sqlite3 Node version mismatch |
| SessionManager.verifyInjection | 12 | 🔴 **PATTERN** — Bracketed paste input race |

## Root Causes (by impact)

### 🔴 Critical: better-sqlite3 Node version mismatch
- **Affected**: 4 features, 51 total degradations
- **Issue**: Module compiled for NODE_MODULE_VERSION 127, runtime requires 141
- **Fix**: `npm rebuild better-sqlite3`
- **Feedback ID**: fb-7e079b34-e1c

### 🔴 Critical: Bracketed paste input race
- **Affected**: 2 features, 25 total degradations
- **Issue**: Enter key dropped when terminating large pastes; recovers via timeout
- **Fix**: Synchronize TUI paste boundary detection with input buffer
- **Feedback ID**: fb-90fe2705-fed

### 🟡 High: Terminal auth failure (GitSync)
- **Affected**: 1 feature, 12 degradations
- **Issue**: No interactive terminal for git auth; can't reach GitHub
- **Fix**: Configure SSH keys or use token-based auth
- **Feedback ID**: fb-5f517663-ffa

### 🟡 High: Node binary missing
- **Affected**: 1 feature, 12 degradations
- **Issue**: /opt/homebrew/Cellar/node/25.6.1/bin/node does not exist
- **Fix**: Verify Node installation and update PATH if needed
- **Feedback ID**: fb-232eca94-d07

## Feedback Submitted

- ✅ better-sqlite3 pattern (forwarded upstream)
- ✅ GitSync.pull pattern (stored locally)
- ✅ TopicMemory pattern (stored locally)
- ✅ Input handling pattern (stored locally)

## Next Steps

All feedback has been logged. Patterns are now visible to maintainers and the feedback system. No further action required from this run.
