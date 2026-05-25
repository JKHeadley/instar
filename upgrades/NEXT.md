# Upgrade Guide — Codex safety hooks now actually fire

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: on Codex (codex-cli) agents, the PreToolUse safety guard now actually fires
and blocks dangerous commands. Previously it was registered but silently never ran.**

Two mismatches between how instar wrote the Codex hook config and how Codex actually
invokes hooks:

1. **Invalid tool-call matcher.** `installCodexHooks` emitted `matcher: "*"`. Codex
   treats the matcher as a regex against the tool name, and a bare `*` is an invalid
   quantifier that matches nothing — so the gate never fired. Session-level hooks
   (SessionStart, UserPromptSubmit) fired fine because they aren't tool-matched, which
   masked the problem. Changed to `".*"` (match all tool calls).
2. **Wrong command field.** Codex's shell tool is `exec_command` and puts the command
   in `tool_input.cmd`; the guard's stdin shim only read `tool_input.command` (Claude's
   shape), so even once it fired it saw an empty command. The shim now reads either.

Claude agents are unaffected — their existing argument path is unchanged and still tested.

## What to Tell Your User

If I'm running on the Codex engine, my safety guard that blocks catastrophic commands —
things like wiping a disk — now genuinely stops them before they run. Until this fix the
guard was installed but never actually triggered on Codex, so dangerous shell commands
could slip through. Nothing changes if I'm running on Claude; this only closes the gap on
the Codex side.

## Summary of New Capabilities

No new user-facing capabilities — this is a correctness fix to the existing Codex
enforcement-hook layer. Codex agents that update will have a working PreToolUse safety
gate (dangerous-command guard + external-operation gate + grounding check) where before it
was inert. Existing Codex agents receive it on update via PostUpdateMigrator (matcher +
stdin-shim fixes ship through both the init and update paths).

## Evidence

**Live reproduction (real Codex engine, not a simulation).** Regenerated a Codex test
agent's hooks from freshly-built source via the real `refreshHooksAndSettings` path (no
hand-editing, no debug instrumentation), launched real interactive Codex v0.133.0, and told
it to run `echo 'rm -rf /'`.

- **Before the fix:** identical setup — Codex ran the command unblocked; the guard never
  fired (debug trace empty).
- **After the fix:** Codex displayed `• PreToolUse hook (blocked) — BLOCKED: Catastrophic
  command detected: rm -rf /` and did not execute it. First confirmed firing of the Codex
  enforcement guard in the real engine.

**Regression coverage:** the integration test now uses Codex's verified payload shape
(`tool_name: exec_command`, `tool_input.cmd`) — it would have failed before the shim fix —
plus a Claude-stdin case; a unit test asserts the matcher is `".*"`, not `"*"`. Full Codex
hook suite: 19 green. `tsc` clean.
