<!-- bump: patch -->

## What Changed

Thirteen background LLM call sites that were quietly running on the default
framework (Claude) now route off-Claude with their peers. The framework router
picks a provider by a component's category; these thirteen were absent from the
category map, so they resolved to `other` and fell back to Claude — burning
Anthropic quota while near-identical siblings routed to the cheaper, less
rate-limited off-Claude providers.

They were the pinned `WIRING_EXCLUSIONS` backlog explicitly deferred from the
token-audit PR ("each needs its own deliberate routing decision"). This is that
decision: each is registered by function — `InputClassifier`,
`SessionSummarySentinel`, `TelegramAdapter` (sentinel; `TelegramAdapter` also fixes
an asymmetry versus the already-registered `SlackAdapter` alert-suppression judge);
`ResumeValidator` (gate); and `Usher`, `TopicIntentExtractor`, `PreCompactionFlush`,
`TreeSynthesis`, `LLMConflictResolver`, `openConversationBrief`, `a2a-checkin`,
`correction-learning`, `mentor-stage-b` (reflector).

`WIRING_EXCLUSIONS` now holds only the five components that route via an explicit
`attribution.category` and are correctly map-unregistered. The existing wiring
ratchet remains the drift guard against future recurrence. Additive and fully
reversible; no new logic, no new decision authority.

## What to Tell Your User

Thirteen of my small background AI helpers — the ones that classify messages,
summarize sessions, extract facts before compaction, and similar housekeeping —
were quietly running on Claude instead of the cheaper providers the rest of my
background checks use. That was burning Claude subscription quota (the scarce,
rate-limited resource) on work that never needed it. They now route off Claude
like their peers, so more of your Claude quota stays available for the
conversations and heavy work where it matters. Nothing changes in what these
helpers do — only which provider quietly runs them.

## Summary of New Capabilities

None — no new API routes, config keys, or user-facing behavior. This is a
routing-map completion: 13 existing internal LLM call sites now resolve to their
proper category (`sentinel`/`gate`/`reflector`) so the existing
Provider-Fallback Default Policy routes them off Claude. Operators can still
override any of them per-agent via `sessions.componentFrameworks.overrides`.

## Evidence

Before: `GET /intelligence/routing` on a live agent showed these 13 components
absent from the known-components registry, and `categoryForComponent()` in the
deployed dist resolved each to `'other'` → the agent default framework (Claude).
Verified against the deployed code during the 2026-07-01 LLM Routing Registry
audit (docs/LLM-ROUTING-REGISTRY.md), not just the source branch — each of the
13 calls `.evaluate()` with an `attribution.component` that had no map entry and
no explicit `attribution.category`, while siblings like `SlackAdapter` (mapped)
routed off-Claude.

After: `categoryForComponent('InputClassifier')` → `'sentinel'` (and likewise
for all 13; `'TelegramAdapter'` now matches the already-mapped `SlackAdapter`).
The wiring ratchet (`tests/unit/llm-attribution-ratchet.test.ts`) proves both
directions over the real source tree: every literal `attribution.component` in
`src/` resolves to a registered category or a pinned explicit-category
exception, and every remaining exception genuinely resolves to `'other'`. The
router, integration, and e2e routing suites are green unchanged.
