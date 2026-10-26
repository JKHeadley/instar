# Five staged features retired after the 2026-10-25 maturation review

## What Changed

- Removed `JevReviewFlagShadow` (the once-a-minute "does this reply need your review?" measurement) and its `GET /jev-review-flag/summary` route; its instruction-file card is stripped from `CLAUDE.md` and the `AGENTS.md` / `GEMINI.md` mirrors on exact match against a frozen copy (a hand-edited card is left in place and named in the update output).
- Removed `ProactiveCompactionSentinel` (`monitoring.proactiveAutonomousCompaction`, never enabled; context-wall recovery already compacts first).
- Removed the dry-run `MoveIntentClassifier` and `ProfileIntentClassifier` (the "move this to <nickname>" / "use codex here" recognizers): zero would-actuate decisions across their whole soak; the explicit routes the agent already calls (`POST /pool/transfer`, `POST /topic-profile/:id/propose` + the operator's confirm, the dashboard controls) do both jobs. Their census rows, registries, bounded-input baseline entries and tests go with them; the topic pin store built in the same code block is kept.
- Removed the unread `cartographer.conformanceAudit.llmEnrichment` / `cartographer.subtreeNav.llmRerank` flags and the call-site-less `StandardsCoverageEnrichment` component.
- New `PostUpdateMigrator` step `migrateRetireStagedFeaturesCmt1004` (marker `retire-staged-features-cmt1004-v1`): deletes the persisted keys above plus a stray top-level `quotaLimits` (only when it equals the known junk value `{"enabled": false}`), honors `_instar_noMigrate`, and records every removed block's known scalar fields in the update output — with a `REVIEW:` prefix when a block had been deliberately enabled.
- Two instruction cards corrected in the template and patched in place on existing agents: the pool-transfer card no longer says the server catches a natural-language move (the agent calls the route; the leftover session is closed by the transfer's drain step, otherwise within ~2 reaper ticks), and the topic-profile card now names `POST /topic-profile/TOPIC_ID/propose` with the `X-Instar-Request: 1` header and its outcomes.

## What to Tell Your User

Five experimental features that were switched off or only watching have been removed, because a review by two different AI model families found they were not earning their keep. You will not notice any change in how I behave: the "move this conversation to my other machine" and "use a different model here" requests were always handled by me calling the proper route, never by a server-side guesser. Your settings file gets a little shorter after the update, and my instruction file loses one paragraph about a cancelled experiment. If you had deliberately turned one of these features on, the update message says so in a line that starts with the word REVIEW.

## Summary of New Capabilities

None — a removal. The agent's instruction file gains one corrected bullet naming the topic-profile propose route it already had.

## Evidence

Spec `docs/specs/retire-staged-features-2026-10-25.md` (converged 3 rounds: Codex GPT-6 Astra + clean-door Fable + internal panel + constitution gate; report at `docs/specs/reports/retire-staged-features-2026-10-25-convergence.md`). Soak logs on the development agent: `logs/move-intent.jsonl` 1,120 / 1,120 `pass`, `logs/profile-intent.jsonl` 1,807 / 1,807 `pass`. Migration cases covered in `tests/unit/PostUpdateMigrator-retire-staged-features.test.ts`; acceptance grep over `src/` finds only the migration literals and the frozen card; the full suite ran once green in the worktree (PR body carries the run summary).
