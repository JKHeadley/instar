---
title: detectFrameworkBinary scans nvm version dirs (launchd-PATH-excluded binaries)
slug: detect-framework-binary-nvm
status: approved
review-convergence: 2026-05-31T11:40:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481).
  Bug #10 of the multi-machine live-transfer cascade, found live: a session spawn
  on the nvm-only mini crashed because claudePath resolved to null. Verified in the
  mini server's node env (detectClaudePath() => null, NVM_BIN unset). Flagged in the
  PR per cross-agent discipline.
---

# detectFrameworkBinary scans nvm version dirs

## Problem

Found live (2026-05-31): with bugs #4/#5/#6/#8/#9 fixed, "move this to the Mac mini"
forwards, the mini accepts + persists the session — but the spawned Claude session
dies instantly: `Session "…" died during startup … tmux died during fresh startup`.

Root, verified by running the resolver in the mini server's own node env:

```
detectClaudePath() => null
NVM_BIN: (unset)
PATH has nvm bin: false
```

The mini's `claude` binary lives at `~/.nvm/versions/node/<ver>/bin/claude`. But
`detectFrameworkBinary` only finds an nvm binary via `process.env.NVM_BIN` — which is
set by nvm's shell init, NOT in the launchd environment the server runs under. The
other candidates miss too (no `~/.claude/local/claude`, no homebrew, `npm`/`which`
not on the launchd PATH). So `claudePath` resolves to `null`, and a session spawned
with no Claude binary dies immediately.

This is the exact failure class the existing asdf-shim search already guards against
("the launchd/login PATH frequently excludes that dir") — nvm needs the same.

## Goal

`detectFrameworkBinary` finds a framework CLI installed under an nvm version dir even
when the server runs under launchd (no nvm-initialized shell, `NVM_BIN` unset), so a
session spawn on an nvm-only machine works.

## Non-goals

- Does NOT change the candidate PREFERENCE order for machines where detection already
  succeeds (the nvm scan is appended after the existing system/npm/NVM_BIN
  candidates; a binary found earlier still wins).
- Does NOT address bug #7 (standby outbound mute) — separate.
- Does NOT add a runtime PATH mutation; it only widens detection.

## Design

In `detectFrameworkBinaryUncached`, after the `NVM_BIN` check, scan
`~/.nvm/versions/node/`: push `<process.version>/bin/<name>` first (prefer the
running node's version), then every installed `<ver>/bin/<name>`. Wrapped in a
best-effort try/catch (a missing/unreadable nvm dir is a no-op). The existing
candidate loop then returns the first that exists. Mirrors the asdf-shim handling.

## Testing

- Tier 1 (`detectFrameworkBinary.test.ts`): with `HOME` pointed at a temp dir
  containing `~/.nvm/versions/node/v99.0.0/bin/plandex` and `NVM_BIN` DELETED,
  detection resolves to that binary (proves it works without NVM_BIN — the launchd
  case). Plus a source-guard that Config.ts scans the nvm version dirs.
- 24 detection + loadConfig tests green; `tsc --noEmit` clean.
- Tier-3: the next live re-test confirms the spawned session on the mini no longer
  dies at startup (claudePath now resolves).

## Migration parity

Pure code (additional detection candidates). No config/hook/route/CLAUDE.md change.
Strictly widens detection — machines that already resolved a binary are unaffected.
Existing agents get it on the v-next update.
