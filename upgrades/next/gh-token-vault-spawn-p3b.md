---
bump: patch
audience: agent-only
maturity: experimental
---

## What Changed

Spawned sessions now receive the agent's OWN GitHub token from its encrypted
per-agent vault (Phase-3 increment P3b, option C — per-agent credential
isolation). At spawn, `SessionManager` resolves `github_token` (or
`github.token`) from the SecretStore and injects `GH_TOKEN` into the session
environment, which the GitHub CLI prefers over the machine-global
`~/.config/gh` seat. With no vault token the spawn is unchanged byte-for-byte;
a vault read problem is fail-soft (one warning, spawn proceeds). The hardened
triage spawn is deliberately excluded — it scrubs credentials by design.

## What to Tell Your User

Nothing user-facing changes. Foundation work (experimental) for credential
isolation on shared machines: when an agent has its own GitHub token stored in
its encrypted vault, work sessions automatically use that token instead of the
computer-wide GitHub login, so agents on a shared machine stop borrowing each
other's GitHub identity. Agents without a stored token keep working exactly as
before.

## Summary of New Capabilities

- Vault-backed GH_TOKEN injection at all three real spawn sites (headless,
  rerouted-interactive, warm interactive); triage spawn excluded by design.
- `resolveGhTokenFromVault(stateDir)` in `src/core/ghToken.ts` — pure-fs,
  never-throws vault resolution (canonical key `github_token`, nested
  `github.token` variant).
- Deflake: the headless-spawn-reroute suite no longer depends on the dev
  machine's live memory pressure.

## Evidence

Verified by 10 unit tests on the resolver (`gh-token-vault`: both key paths,
precedence, trimming, absent vault, non-string, whitespace, corrupt vault
never throws, production dual-key read) and 5 spawn tests
(`session-spawn-gh-token`: real vault to real tmux argv — token present with
INSTAR canaries intact, no-vault byte-for-byte unchanged, corrupt vault
fail-soft, whitespace treated as absent, rerouted lane covered). Canary
suites green: headless-spawn-reroute, session-manager behavioral, terminate,
injection, SecretStore, GitSync, no-silent-fallbacks — 119 of 119. Clean
type-check; docs-coverage floors hold.
