# Side-Effects Review - post-drive transcript auditor

**Version / slug:** `post-drive-transcript-audit`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds a standalone post-drive transcript auditor and CLI command. It reads existing topic message history for specified topics and a time window, classifies operator-seat UX antipatterns, prints a structured report, and writes each finding to the existing framework issue ledger. It also fixes the ledger so a `relatedSpec` citation passed to the write path is persisted on new issues or backfilled on later matching observations.

## Decision-point inventory

- `classifyTranscriptUx` - add - deterministic signal classifier for transcript messages.
- `runPostDriveTranscriptAudit` - add - decides whether to file each classified finding, with dry-run support.
- Framework issue ledger `recordObservation` - modify - preserves related-spec citation metadata; no new authority or route.

## 1. Over-block

No block/allow surface - over-block is not applicable. The auditor can produce false-positive findings, but those are ledger signals for review, not user-message blocks.

The main false-positive risk is classifying a legitimate short status message as content-free. The live fixture dry-run exposed this for normal acknowledgements, so the heuristic was narrowed to repeated/status chatter such as "actively working", "still working", or "no terminal output", and repeated identical notices are grouped.

## 2. Under-block

The auditor still misses UX issues that require deeper conversational interpretation. For example, it will not detect a polite but confusing request unless it contains resend/retry/re-paste language, and it will not detect subtle infrastructure leakage unless it uses the configured infrastructure terms. That is acceptable for this slice because the output is a structured starting signal, not a mentor judgment loop.

The message-history route currently returns a bounded recent history. A large topic with more than the cap between the drive window and audit time could under-report old messages. The command makes the limit explicit and clamps it to the existing server cap; a future slice can add a broader archival reader if needed.

## 3. Level-of-abstraction fit

This is intentionally a low-level detector. It belongs after a drive, not in the live send path, because it is looking for transcript evidence to file. It does not duplicate the tone gate or messaging authority; it feeds the framework issue ledger with evidence pointers so later human or process review has a durable artifact.

The ledger citation fix is at the right layer because the route already accepted `relatedSpec`; losing it inside the storage layer meant callers could do the right thing and still end up with a blind record.

## 4. Signal vs authority compliance

- [x] No - this change produces a signal consumed by an existing ledger.
- [ ] No - this change has no block/allow surface.
- [ ] Yes - but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic - STOP.

The classifier is deliberately brittle and therefore holds no authority. It cannot block, retry, resend, escalate, or alter a transcript. Its only side effect is filing reviewable observations with stable dedupe keys.

## 5. Interactions

- **Shadowing:** no live messaging check is shadowed. The command runs manually after the drive and reads existing history.
- **Double-fire:** repeated runs file the same canonical issue because the dedupe key includes topic, window, category, and message evidence. The live fixture was run twice; the second write deduped.
- **Races:** the only shared state is the framework issue ledger. The ledger already owns SQLite write serialization and episode dedupe.
- **Feedback loops:** there is no mentor judgment loop. Findings do not automatically alter future classifications or message behavior.

## 6. External surfaces

The command reads local server topic history and writes to the local framework issue ledger. That creates persistent state: open framework issue rows and observations. The live fixture run filed three observations for topics 2278 and 2271 in the 11:15-11:21 PDT window. Because the running server still had the pre-fix ledger code loaded, those three rows were updated directly with the related-spec citation after the code fix; future runs through this PR path persist it normally.

No Telegram messages are sent by the command. No GitHub, Cloudflare, or third-party systems are called. The CLI output can include short excerpts, so operators should treat reports as local/private unless deliberately published.

## 7. Rollback cost

Code rollback is a normal revert. The command is additive, and removing it does not affect live messaging. The ledger citation change is backward-compatible: it only fills an existing nullable column. If a filed observation is wrong, the durable record can be closed, marked fixed, or superseded through the existing ledger workflow; no schema rollback is needed.

## Conclusion

This slice is clear to ship as Tier 1. It adds a narrow, post-drive observation tool; keeps classification signal-only; files findings through the existing ledger; and fixes the storage bug that would otherwise erase the parent-principle citation required by the UX-blindspot work.
