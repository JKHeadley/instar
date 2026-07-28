# Side-Effects Review — deferral-detector time/fatigue category

**Version / slug:** `deferral-detector-time-fatigue`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — concurred`

## Summary of the change

Adds a fourth detection category — time/fatigue-based deferral — to the `deferral-detector` hook (source-of-truth: `getDeferralDetectorHook()` in `src/core/PostUpdateMigrator.ts`; deployed copy mirrors it). New `timeFatiguePatterns` array (7 patterns: tail-of-period, end-of-period, avoid-rushing, it's-late, wind-down, do-it-tomorrow, defer-to-later-time). Unlike the orphan-TODO category, `timeFatigueMatches` is NOT gated by the `isInfrastructureBacked` anti-trigger — tracking the work as a commitment/PR does not legitimize time-of-day framing. A new checklist section instructs the agent to quote the actual injected CURRENT TIME and states time-of-day is never a valid defer reason. Still signal-only (`decision: 'approve'`, additionalContext only — never blocks). Files: `src/core/PostUpdateMigrator.ts` (hook template), `tests/unit/deferral-detector-orphan-todo.test.ts` (+9 cases).

## Decision-point inventory

- `deferral-detector` hook outbound-message scan — **modify (additive)** — adds a new signal category. Does NOT change the existing inability/orphan categories or the never-block contract.

## 1. Over-block

No block surface — the hook is signal-only (injects additionalContext, never blocks/denies). "Over-block" → over-FLAG: a legitimate message containing "wrap up" / "end of the day" / "tomorrow I'll" (e.g. "wrap up the report", "tomorrow I'll be on the Slack work") will get the checklist injected. Cost is one extra context block in the agent's turn, never a withheld message. Patterns are scoped to the comm-command gate (only telegram-reply/send-message/etc. are scanned), bounding noise. A notable benign over-flag: when the agent is *explaining this very feature*, its outbound message contains the trigger words and will self-flag — annoying but harmless (signal-only), and identical in kind to the existing orphan-detector flagging messages that discuss "queue for next session".

## 2. Under-block

Pattern set is finite regex; it will miss novel phrasings of time/fatigue deferral. That is acceptable for a signal layer — the patterns cover the observed incident shapes plus common variants; the smart authority (MessagingToneGate) remains the place for context-rich judgment. Residual (stated, not deferred): this does not catch a stale-clock "tonight" used in a non-deferral sentence (e.g. "I'll message you tonight") — deliberately, to avoid flagging every benign time word; only deferral-framed time words are matched.

## 3. Level-of-abstraction fit

Correct layer. This is a brittle keyword detector → it belongs as a SIGNAL (the deferral-detector is exactly that), not as blocking authority. It composes with the existing categories in the same hook at the same altitude. Adding it to the deferral-detector (rather than a new hook) keeps the family cohesive and reuses the comm-command gate, the JSON output contract, and the test harness.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface; it produces a signal (additionalContext) consumed by the agent, exactly per the hook's "SIGNAL ONLY" contract.

A brittle regex detector must NOT hold blocking authority; this addition is consistent — it stays signal-only. If hard enforcement is ever wanted, the right path is feeding the smart gate (MessagingToneGate), not making this regex block. Compliant.

## 5. Interactions

- **Shadowing:** the new category is independent of inability/orphan; `allMatches` concatenates all three. The orphan category's infrastructure-backed suppression is unchanged; the new category intentionally bypasses it (documented). No existing category is shadowed.
- **Double-fire:** a message can now trigger multiple sections (e.g. inability + time/fatigue) — intended; each section is additive context, deduped by category. No double-send.
- **Races:** none — pure stdin→stdout, no shared state.
- **Migration parity:** `deferral-detector.js` is already in the always-overwrite migration set (`result.upgraded.push('hooks/instar/deferral-detector.js ...')`), so the new content redeploys to every agent on update with no new migration entry needed.

## 6. External surfaces

- **Agents/users:** ships to the whole install base via the always-overwrite hook migration. Effect: more frequent (signal-only) checklists when an agent uses time/fatigue deferral framing. No user-visible message change, no API change.
- **Persistent state:** none.
- **Timing/runtime:** depends only on the outbound message text (already available to the hook). No new external calls.

## 7. Rollback cost

Pure additive change to a signal hook template + tests. Back-out = revert the commit; on next update the prior hook content redeploys. No persistent state, no migration to unwind. An individual agent can also neutralize it locally by editing its deployed `.instar/hooks/instar/deferral-detector.js` (until next update). Low.

## Conclusion

A scope-narrowing-of-the-gravity-well, additive signal-only change that closes a real, repeatedly-corrected behavior gap (time/fatigue deferral, laundered by the "tracked it" exemption) with code rather than willpower — directly per the Structure > Willpower standard. No block surface added; signal-vs-authority compliant. Because it modifies a behavioral guard hook, a Phase-5 second-pass review is requested before commit.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: concur**

Concur. The reviewer reconstructed the deployed regexes from the template string and confirmed: (1) escaping is correct (`\\b` → `\b`; all named phrases match, none silently never-match); (2) the key invariant holds — `timeFatigueMatches` is computed OUTSIDE the `isInfrastructureBacked ? [] : …` gate, so a message with `/commit-action` + "tail of the night" STILL fires the time/fatigue section (laundering hole closed); (3) signal-only intact — only `decision:'approve'`, every `process.exit(0)`, no block path; (4) no regression — the existing inability/orphan sections stay gated by their own `.length`, and 12 existing inputs produce zero spurious time/fatigue fires. Over-flag is real but bounded (signal-only, one injected context block, never a withheld message) and disclosed in §1–2. Cosmetic note acted on post-review: broadened `its_late` to also match "it is (getting) late" (was "it's" only), verified firing on the deployed copy.

## Evidence pointers

- Live incident: 2026-06-09 15:41 PDT, topic 2169 — deferral at 3:41 PM framed as "tail of tonight", tracked as CMT-1246, not caught by the old detector.
- Tests: `tests/unit/deferral-detector-orphan-todo.test.ts` time/fatigue block (9 cases incl. the laundering case). Deployed-hook end-to-end check emitted `TIME/FATIGUE DEFERRAL DETECTED` / `Detected: tail_of_period, avoid_rushing` with orphan section suppressed. 25/25 hook tests + 3964 parity/upgrade-guide tests green; tsc + lint clean.
