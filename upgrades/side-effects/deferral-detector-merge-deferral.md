# Side-Effects Review — deferral-detector merge-deferral category

**Version / slug:** `deferral-detector-merge-deferral`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — see below`

## Summary of the change

Adds a fifth detection category — **merge-deferral** — to the `deferral-detector` hook (source-of-truth: `getDeferralDetectorHook()` in `src/core/PostUpdateMigrator.ts`; deployed copy mirrors it via the existing always-overwrite hook migration). New `mergeDeferralPatterns` array (7 patterns) catches two shapes of handing the merge of a **self-authored** PR back to the operator: (a) explicitly assigning the call — "the merge call is yours", "your merge call", "your call to merge", "leave the merge to you", "up to you to merge", "merge is your call to make"; and (b) asking permission to merge one's own PR — "want me to merge?", "should I merge?", "ready to merge?". Like the time/fatigue category, `mergeDeferralMatches` is NOT gated by the `isInfrastructureBacked` anti-trigger — having tracked the PR does not legitimize handing its merge back. A new checklist section instructs the agent to merge a self-authored green PR itself (`scripts/safe-merge.mjs … --squash --admin` / `gh pr merge`), states the operator directed this must never be a blocker (2026-06-09), and carves out the only legitimate non-merges (CI genuinely red on this change; someone else's PR). Still signal-only (`decision: 'approve'`, additionalContext only — never blocks). Files: `src/core/PostUpdateMigrator.ts` (hook template), `tests/unit/deferral-detector-orphan-todo.test.ts` (+11 cases).

## Decision-point inventory

- `deferral-detector` hook outbound-message scan — **modify (additive)** — adds a new signal category. Does NOT change the existing inability/orphan/time-fatigue categories or the never-block contract.

## 1. Over-block

No block surface — the hook is signal-only (injects additionalContext, never blocks/denies). "Over-block" → over-FLAG. Two over-flag classes, both bounded:

- **Permission-seeking on someone else's PR.** "want me to merge your PR?" about a PR the *user* authored is a legitimate question, but it still matches `merge_permission_seeking`. The hook can't see PR authorship from message text, so it flags and lets the agent decide — the checklist explicitly states "it is SOMEONE ELSE's PR (then asking is fine)", so the injected context tells the agent to disregard when that applies. Cost is one extra context block, never a withheld message.
- **Discussing this very feature.** A message *about* merge-deferral (like this one) contains the trigger words and will self-flag — annoying but harmless (signal-only), identical in kind to the orphan/time-fatigue categories self-flagging when discussed.

Patterns are scoped to the comm-command gate (only telegram-reply/send-message/etc. are scanned), bounding noise to outbound human messages.

## 2. Under-block

Pattern set is finite regex; it will miss novel phrasings ("I'll let you make the merge decision on this", "the green light to merge is yours"). Acceptable for a signal layer — patterns cover the observed incident shape ("the merge call is yours") plus the common permission-seeking variants the operator's directive named. Residual (stated, not deferred): the detector does not attempt to verify PR authorship or CI state — it is a framing detector, not a merge executor. The actual auto-merge-on-green behavior lives in instar-dev Phase 7 (the skill flow); this hook is the cross-cutting catch for when an outbound message hands the merge back regardless of flow.

## 3. Level-of-abstraction fit

Correct layer. This is a brittle keyword detector → it belongs as a SIGNAL (the deferral-detector is exactly that), not as blocking authority. It composes with the existing four categories in the same hook at the same altitude, reusing the comm-command gate, the JSON output contract, and the test harness. A complementary structural surface already exists at a different layer: instar-dev Phase 7 ("Auto-merge on green — never pause to ask") governs the build flow. This hook covers the gap Phase 7 doesn't: a self-authored-PR merge handed back in *any* outbound message, not only inside an instar-dev build. The two are layered (flow-level prescription + message-level detector), not parallel duplicates.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface; it produces a signal (additionalContext) consumed by the agent, exactly per the hook's "SIGNAL ONLY" contract.

A brittle regex detector must NOT hold blocking authority; this addition stays signal-only. If hard enforcement is ever wanted, the right path is the instar-dev pre-commit/merge gates (which already exist) or feeding the smart gate (MessagingToneGate), never making this regex block. Compliant.

## 5. Interactions

- **Shadowing:** the new category is independent of inability/orphan/time-fatigue; `allMatches` concatenates all categories. The orphan category's infrastructure-backed suppression is unchanged; the new category intentionally bypasses it (documented, mirrors time/fatigue). No existing category is shadowed.
- **Double-fire:** a message can now trigger multiple sections (e.g. permission-seeking inability + merge-deferral) — intended; each section is additive context. No double-send.
- **Races:** none — pure stdin→stdout, no shared state.
- **Migration parity:** `deferral-detector.js` is already in the always-overwrite migration set (`result.upgraded.push('hooks/instar/deferral-detector.js …')`), so the new content redeploys to every agent on update with no new migration entry needed.

## 6. External surfaces

- **Agents/users:** ships to the whole install base via the always-overwrite hook migration. Effect: more frequent (signal-only) checklists when an agent hands a self-authored merge back or asks permission to merge. No user-visible message change, no API change.
- **Persistent state:** none.
- **Timing/runtime:** depends only on the outbound message text (already available to the hook). No new external calls.

## 7. Rollback cost

Pure additive change to a signal hook template + tests. Back-out = revert the commit; on next update the prior hook content redeploys. No persistent state, no migration to unwind. An individual agent can also neutralize it locally by editing its deployed `.instar/hooks/instar/deferral-detector.js` (until next update). Low.

## Conclusion

An additive, signal-only change that closes a real, freshly-corrected behavior gap (handing a self-authored green PR's merge back to the operator — incident 2026-06-09, PR #1040 presented as "the merge call is yours") with code rather than willpower — directly per the Structure > Willpower standard, and reinforcing the operator directive that a self-authored merge must never be a blocker. No block surface added; signal-vs-authority compliant; layered with (not duplicating) instar-dev Phase 7. Because it modifies a behavioral guard hook, a Phase-5 second-pass review is requested before commit.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: concur**

Concur — no must-fix bugs found. The reviewer independently rendered the deployed hook (`getHookContent('deferral-detector')` → `node -c` valid JS) and confirmed: (1) **escaping correct** — every `\\b` → `\b` in the deployed regex, both `\\'` → valid `\'` in the single-quoted checklist strings, no stray backtick / broken escape / silently-never-matching regex (all 7 patterns matched real inputs); (2) **the laundering invariant holds** — `mergeDeferralMatches` is computed by a plain `.filter()` OUTSIDE the `isInfrastructureBacked ? [] : …` gate, verified empirically that "tracked commitment + follow-up PR … but the merge call is yours" STILL fires; (3) **signal-only intact** — exactly one output path (`decision:'approve'`, additionalContext only), six `process.exit(0)`, no block/deny/ask path; (4) **no regression** — the only source deletion is the single `allMatches` line re-spread to append `...mergeDeferralMatches`; inability/orphan/time-fatigue arrays + gates + sections byte-for-byte unchanged; (5) **false-positive profile acceptable** — all must-NOT-fire cases ("I merged it myself", "I'll merge on green", "merging now", "Both fixes verified live") plus 10 more benign merge-mentioning messages produced zero firings; full file 35/35. Bounded over-fire noted (permission-seeking pattern (b) can fire on non-PR "safe to merge these branches?" uses) — over-FLAG not over-block, anticipated in §1, judged not-must-fix for a signal layer (anchoring it to own-PR context would risk under-firing the real incident shape). Under-fire on novel framings noted as expected residual.

## Evidence pointers

- Live incident: 2026-06-09, topic 2169 — the agent built PR #1040 (auto-heal ladder) and presented it as "CI is running now … the merge call is yours," prompting the operator's correction: "the merge call should never be mine, at least not for PRs you authored. Please change this permanently moving forward so it is never a blocker."
- Tests: `tests/unit/deferral-detector-orphan-todo.test.ts` merge-deferral block (11 cases) incl. the exact incident phrasing, the permission-seeking variants, the "tracked PR still fires" laundering case, and the must-NOT-fire cases ("I merged it myself", "I'll merge on green", "merging now"). Generated-hook node syntax check passed; `tsc --noEmit` exit 0; 35/35 deferral-detector tests green.
