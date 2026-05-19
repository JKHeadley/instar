# Upgrade Guide — v1.0.9 (portability hardening 1 of 6)

<!-- bump: patch -->

## What Changed

First of the six cross-framework portability hardening patches the v1.0.8
release notes committed to (v1.0.9–v1.0.14).

`instar init` now writes the non-Claude identity files (AGENTS.md for Codex,
GEMINI.md for Gemini) from the canonical `.instar/AGENT.md` at setup time,
instead of writing only the Claude-Code-specific CLAUDE.md and leaving
non-Claude runtimes with no identity file until the first server spawn.

A new `renderNonClaudeIdentityShadows` helper renders every known framework
shadow except `claude-code` (whose CLAUDE.md is a rich capability document,
intentionally left to its own generator). It is additive, idempotent, and a
safe no-op when no canonical identity exists yet.

## Evidence

Reproduction prior to this change: run `instar init` for a project intended to
run under Codex. Result: a CLAUDE.md (which Codex does not read) and no
AGENTS.md. The agent had no auto-loaded identity until the first server spawn
triggered the runtime self-heal.

Observed after this change: the same setup additionally produces AGENTS.md and
GEMINI.md rendered from the canonical identity, immediately at init. CLAUDE.md
is byte-for-byte unchanged. With no canonical AGENT.md present the helper is a
clean no-op and does not throw.

Unit verification: `tests/unit/renderNonClaudeIdentityShadows.test.ts` — five
cases: renders AGENTS.md + GEMINI.md from canonical AGENT.md; never
writes/clobbers CLAUDE.md; no-op-no-throw when AGENT.md is absent; idempotent;
Telegram relay appendix on request.

## What to Tell Your User

- "If you set up an agent to run on Codex or Gemini, it now gets the right identity file from the moment you create it, instead of only after its first session start. Claude Code setups are unchanged."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Init-time non-Claude identity | Automatic during `instar init`. AGENTS.md / GEMINI.md are rendered from the canonical identity alongside CLAUDE.md. |
| Idempotent re-render | The helper reproduces identical shadow content on repeat runs and no-ops without a canonical source. |

## Deferred (Tracked Follow-ups)

- Five remaining cross-framework portability gaps ship as v1.0.10–v1.0.14:
  framework-aware connector-server registration, framework-session-store
  abstraction, neutral relay-script path, post-update-migrator framework
  guards, and the migrator/identity-renderer unification (which will revisit
  how CLAUDE.md relates to the canonical identity render).
