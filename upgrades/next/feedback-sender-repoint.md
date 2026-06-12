# Upgrade Guide — Canonical feedback endpoint cutover (Phase 4)

<!-- bump: minor -->

## What Changed

**This release is the feedback-factory cutover flip** (docs/specs/feedback-factory-migration.md §2.5 Phase 4, merged inside the announced cutover window): the fleet's canonical feedback endpoint moves from Portal's receiver (`dawn.bot-me.ai/api/instar/feedback`) to the Instar operated instance's canonical front (`feedback.instar.sh/api/feedback`).

- **Single-source constant.** `src/core/canonicalFeedback.ts` now defines `CANONICAL_FEEDBACK_URL` + `LEGACY_FEEDBACK_URLS`; the Config loader default and both init shapes consume it (the literal URL can never drift across call sites again — pinned by test).
- **Migration Parity (the actual fleet repoint).** An idempotent `PostUpdateMigrator.migrateConfig` block rewrites a deployed agent's `feedback.webhookUrl` to the canonical front **only when it exactly equals a known legacy canonical default**. A custom operator webhook URL is structurally untouched (exact-match allowlist). Variant spellings that miss the match keep working through the old receiver's 301/proxy-forward (spec Phase 5) — the long tail loses nothing.
- **Unchanged:** the HMAC signing model and shared secret (same key through cutover, spec §2.9), the sender code itself, and `dispatches.dispatchUrl` (the dispatch move is sequenced separately).

## What to Tell Your User

- "The address I send Instar bug reports and feedback to has moved to its new home (run by the Instar maintainer). This happened automatically with this update — nothing for you to do, and no reports were lost: the old address keeps forwarding while the fleet rolls over."
- "If you ever configured a CUSTOM feedback webhook of your own, it was not touched."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Canonical feedback endpoint (stable) | Automatic — `feedback.webhookUrl` repoints on update; new installs get it via `init` |
| Single-source endpoint constant | `src/core/canonicalFeedback.ts` (`CANONICAL_FEEDBACK_URL`) |

## Evidence

- `tests/unit/PostUpdateMigrator-feedbackUrlRepoint.test.ts`: both sides of the rewrite decision boundary (legacy URL repointed / custom URL untouched), idempotency (second run = no change), no-invention on absent config, legacy-list regression pin, and the canonical URL passing the sender's own `validateWebhookUrl` gate.
- `tests/unit/feedback-webhook.test.ts` updated: Config loader resolves through the constant; the legacy literal is banned from the loader source.
- Full unit suite green; side-effects artifact `upgrades/side-effects/feedback-sender-repoint.md` with independent second-pass review.
- Live pre-merge gate (operational, in the cutover runbook): signed HMAC round-trip against `https://feedback.instar.sh/api/feedback` verified green before the freeze window opened.
