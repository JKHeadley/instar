# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**docs(openclaw-t22): document codex framework limitation on pre-prompt memory recall.**

Spec note added to `docs/specs/OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md` acknowledging that the pre-prompt memory recall feature (T2.2) only fires on Claude Code sessions. Codex CLI does not expose an equivalent per-prompt hook, so on codex-configured topics the recall pass does not run. This is a documented v1 scope choice surfaced by the 2026-05-21 OpenClaw v1.0 re-audit in topic 9003.

The server-side `PromptBuildRecall` primitive remains framework-agnostic — if codex later gains a pre-prompt hook (or a session-start trigger becomes acceptable), wiring it is a small follow-up. The asymmetry is honest, documented, and reversible.

The ELI16 companion at `OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.eli16.md` was updated in plain language so operators understand the limitation before enabling the feature on a codex-configured topic.

No code changes; spec + ELI16 only.

## What to Tell Your User

If you have a Telegram topic configured to run on the Codex CLI framework (via `topicFrameworks` in `.instar/config.json`), the pre-prompt memory recall feature does not fire on that topic — your other grounding behaviors continue to work normally. This is a documented limitation, not a bug. Claude Code topics work the same as before. If codex usage matters more later, a session-start variant of the recall pass is a small follow-up.

## Summary of New Capabilities

No new capabilities. Documentation-only release surfacing an existing v1 limitation.
