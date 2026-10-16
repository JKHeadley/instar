# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Correction & Preference Learning Sentinel distilled a user message into a learning only when its Layer-0 keyword detector marked it, and that detector misses most real corrections. The Jev correction shadow (`intelligence.jevCorrectionShadow`) has measured this live on the development agent since 2026-10-05: 40 messages Jev flagged and Layer 0 missed, about 33 of them genuine operator corrections or standing rules, 7 of them desk notes this agent posted through the operator's account ("From Echo (…), not from Justin:"). The sentinel learned from none of them.

- **Live feed** (`intelligence.jevCorrectionShadow.feedSentinel`, new, optional): when Jev flags a message (the existing P(correction) + P(preference) ≥ 0.5 line) and Layer 0 did not, the shadow hands it to the sentinel, which runs its existing `captureAndDistill` with the same ring, ledger, LlmQueue daily cap, per-topic rate ceiling, load-shedding and backlog. The distill sees the conversation as it stood at that message (`windowEndingAt`; the turn is not pushed twice). The occurrence carries the minimum Layer-0 weight (`LEARNING_DETERMINISTIC_THRESHOLD`, 3) so the unchanged recurrence gate (4 occurrences, 2 days, 2 sessions) can count it. Audit rows from the feed carry `trigger: 'jev'`.
- **Exclusions:** a message opening "From <this agent's name>" (`config.projectName`, whole word, case-insensitive) or carrying an agent-signature tag is never fed. The shadow still logs it.
- **Gating:** omitted ⇒ dev gate (live on a development agent, dark on the fleet); `false` stops the feed on the next message without a restart, and the shadow keeps measuring. Inert unless the shadow is on, the vault holds `typesafe_api_key`, and `monitoring.correctionLearning.enabled` constructed the sentinel. Registered in `DEV_GATED_FEATURES` as `jevCorrectionFeedSentinel`.
- **Rows and summary:** a Jev-only check row gains `fed` (`fed`, `excluded-agent-prefix`, `excluded-signed`, `no-topic`, `no-sentinel`, `feed-error`) when the feed is on; `GET /jev-correction/summary` gains `fed` and `feedSkipped`.
- **CLAUDE.md:** the Jev Correction Shadow card is rewritten for the feed and both switches; `migrateClaudeMd` replaces an installed log-only card once (sniffed on its log-only sentence).

## What to Tell Your User

When you correct me or tell me how you want something done from now on, I'm now much better at noticing. Before, I only picked it up when you used certain keywords, and I missed most of your corrections. Now a second, smarter check catches the ones the keywords miss and passes them to the part of me that learns your preferences. I still only turn something into a standing habit after it comes up several times, on different days, so one passing remark won't change how I work. Notes my own background sessions post through your account are left out.

## Summary of New Capabilities

- Corrections and standing preferences that the keyword check misses now reach the preference learner.
- The correction measurement summary shows how many were passed on and why any were skipped.

## Evidence

- Live evidence: `logs/jev-correction-shadow.jsonl` on the development agent, joined by message id to the Telegram log on 2026-10-15: 40 Jev-only flags, 7 opening "From Echo (…)".
- Unit: `tests/unit/jev-correction-shadow.test.ts` (feed with text/topic/session and content-free `fed`; off when omitted or false; kill switch read live; no feed for a Layer-0 signal or below the line; agent-prefix and signed exclusions; no-sentinel / no-topic / feed-error; `feedExclusion` both sides; factory dev gate), `tests/unit/CorrectionCaptureLoop.test.ts` (`windowEndingAt` cut and fallback; supplied window distilled once, ring not pushed again, weight recorded).
- Integration: `tests/integration/jev-correction-shadow-routes.test.ts` (real TelegramAdapter + sentinel capture chain + real CorrectionLedger: a Jev-only preference is recorded once at weight 3 with a `trigger: 'jev'` audit row; a "From <agent>" note is not; summary counts).
- E2E: `tests/e2e/jev-correction-shadow-lifecycle.test.ts` (production factory over `config.json`: fed on a dev agent, dark on the fleet with the shadow on, held by `feedSentinel: false`; dev-gated registration and server.ts wiring; stale card replaced once, idempotent).
