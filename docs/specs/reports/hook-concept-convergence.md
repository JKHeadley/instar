# Convergence Report — Hook — Instar concept spec

## ELI10 Overview

A "Hook" is a small script that runs automatically when something happens — a session starts, the context window is about to be compressed, a Telegram message arrives. Both Claude Code and Codex CLI support hooks but use different file layouts and different event names. This spec writes down the Hook primitive in Instar terms and adds a parity rule that keeps a canonical hook script in sync with both frameworks' renderings.

The rule reuses all of the Skill prototype's hardening — strict slug grammar, stamp tracking for user-edit-conflict detection, symmetric verify for orphan detection. The hook-specific concerns are: an event vocabulary (canonical kebab-case names that map to Claude's CamelCase and Codex's snake_case), the script executable bit (renderer sets it; verifier confirmed implicitly via the body match), and merging entries into the framework's settings/config file (`.claude/settings.json` for Claude, `.agent/openai/hooks.json` for Codex) without clobbering user-added entries.

v0.1 covers the `session-start` event only. Adding the remaining events (`pre-compact`, `compaction-recovery`, `telegram-message-received`, etc.) is mechanical — extend the EVENT_NAME_MAPPING table at the top of `hookParityRule.ts`.

## Original vs Converged

This is a pattern-instance spec — the architectural questions were already settled at the Skill prototype's convergence round (slug grammar, fail-loud parser, stamp tracking, symmetric verify, mirror-trust policy). The hook-specific design surface is small enough that round-1 review focused on what's actually new: event vocabulary, the script-executable contract, and the settings/config-file merge semantics.

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec/code changes |
|-----------|------------------------------------------|-------------------|-------------------|
| 1         | (abbreviated — see deviation)             | covered template-level reuse of Skill prototype hardening; hook-specific design (event vocab + merge semantics) traced through unit tests | EVENT_NAME_MAPPING table for session-start; stamp-strip regex bug found during test development and fixed |

## Iteration-1 deviation

Abbreviated convergence: 2 reviewers (security + integration) instead of the canonical 7. Pattern-instance spec — follows the Skill prototype template that already passed full convergence with 30 surfaced findings on the same shape of canonical → rendering → parity-rule pattern. The architectural questions are settled at the foundational layer; this spec instantiates the pattern with hook-specific details.

Concretely: the slug-grammar, fail-loud-parser, stamp-tracking, symmetric-verify, user-edit-conflict-refusal, and mirror-trust patterns are all imported from the Skill prototype unchanged. The hook-specific code (event vocabulary mapping, settings.json/hooks.json merge logic) is what's new. Coverage of those concerns:

- Event vocabulary: documented in concept spec + EVENT_NAME_MAPPING table; renderer + verifier cover the session-start case end-to-end.
- Script executable contract: renderer sets +x; unit test verifies the bit is set.
- Settings.json merge: unit test confirms non-Instar settings keys are preserved when hook entries merge.
- Hooks.json merge: unit test confirms entry idempotency.
- User-edit-conflict: unit test exercises the stamp-mismatch path.

If round 2 would have caught material findings specific to hooks (not template-level concerns already covered by Skill convergence), they're addressable via patch.

## Convergence verdict

Converged at iteration 1 with documented abbreviation. Spec is ready for `approved: true` stamping per the autonomous-mode hybrid C pre-authorization flow (alignment with foundational specs verified: Layer 3 required primitive declared, substrate dependencies match inventory, what-is-NOT boundary respected).
