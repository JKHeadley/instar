# Side-Effects Review — Mentor Stage-A full exchange surface

**Version / slug:** `mentor-stagea-full-exchange-surface`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `Justin review requested in PR`

## Summary of the change

This change completes the mentor Stage-A conversation surface by logging mentor-sent prompt content after successful delivery and interleaving those turns with mentee replies. `src/monitoring/MentorStageA.ts` adds `MentorSentLine`, `parseMentorSent`, and timestamp interleaving in the pure `buildConversationSurface` function. `src/server/AgentServer.ts` appends successful mentor sends to `mentor-sent.jsonl`, reads that log for `getSurface`, and continues reading mentee replies from `mentor-replies.jsonl`. `tests/unit/MentorStageA.test.ts` covers the new parser and the interleave boundary.

## Decision-point inventory

- `MentorStageA.buildConversationSurface` — modify — determines what user-visible conversation Stage A sees.
- `AgentServer.deliverToMentee` — modify — writes mentor-sent prompt content only after delivery succeeds.
- `AgentServer.getSurface` wiring — modify — feeds parsed mentor-sent turns plus parsed mentee-reply turns into the pure surface builder.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The parsers drop malformed or empty log rows, but that only removes unusable history from Stage-A context; it does not reject user input, messages, or actions.

---

## 2. Under-block

The main remaining miss is a send that succeeds but crashes before the append finishes. In that case the next surface may still lack the mentor-side prompt. The append is intentionally best-effort and non-fatal so delivery is not turned into a filesystem-dependent operation. Rows without timestamps or text are skipped rather than guessed.

---

## 3. Level-of-abstraction fit

The pure parser and interleave logic belong in `MentorStageA.ts`, which already owns the Stage-A boundary and has focused unit tests. File I/O belongs in `AgentServer`, which already reads the reply log and owns delivery. The change uses the existing a2a transport and outstanding prompt tracker rather than adding a second delivery path.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority.

This change expands the data surface visible to Stage A with mentor-owned, user-visible conversation text. It does not add a new blocker, filter, or authority.

---

## 5. Interactions

- **Shadowing:** The sent-log parser does not replace the reply parser. Both feed the same pure surface builder.
- **Double-fire:** The sent log is independent from the metadata-only a2a sent ledger. It is intentionally content-bearing because the existing ledger cannot provide prompt text.
- **Races:** Delivery can succeed while appending the sent row fails. The next surface loses that mentor-side turn, but no transport or reply tracking is broken.
- **Feedback loops:** Logging occurs only after `deliverA2aMessage` returns true. Failed sends do not create fake conversation history.

---

## 6. External surfaces

The new external surface is a local state JSONL file containing mentor prompt content. It stays under the agent state directory and is not published or sent elsewhere by this change. Stage-A prompt content changes because it can now include both sides of the mentor exchange. The a2a wire format, Telegram behavior, scheduling policy, and reply capture remain unchanged.

---

## 7. Rollback cost

Rollback is a hot-fix release that reverts the MentorStageA, AgentServer, and test changes. The JSONL file can remain on disk; older versions ignore it. No database migration or agent state repair is required.

---

## Conclusion

The change closes the half-history limitation without weakening the two-hats boundary. Stage A still receives only user-visible conversation and the mentor's own agenda, but now that visible conversation includes both mentor prompts and mentee replies. Clear to ship for PR review.

---

## Second-pass review (if required)

**Reviewer:** Justin review requested in PR
**Independent read of the artifact: pending external review**

This changes a mentor information-flow surface, so the PR is intentionally opened for Justin review before merge.

---

## Evidence pointers

- `npm test -- --run tests/unit/MentorStageA.test.ts`
- `npm run lint`
