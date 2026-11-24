# Side effects: re-offer after a real problem (rollout step 4, reason 1, voice-unreadable)

**STANDARD.** About 10 source files: a new pure module `src/recommended/reoffers.ts`, a `reoffer` row type in the signed ledger, route wiring, a config type, and a signal in the shared voice transcription wrapper plus two channel call sites. New unit, integration and e2e tests. Ships dark.

## Summary
`src/recommended/RecommendedServicesLedger.ts` gains `ReofferRow` (`event` / `pending` / `offered`, exact validation, `evidenceRef` a fixed token, never text). `src/recommended/reoffers.ts` is the deterministic floor from docs/specs/recommended-services.md ("Re-offering after a no" reason 1, "Real-problem events"): the choice must be `no` or an unanswered delivered offer, the problem after it and fresh (30 days), per kind+service cool-off 90/180/360, one re-offer a day across services, spent on delivery, reservations released after 7 days. `recommendedServiceRoutes.ts` adds `handle.recordProblem(kind, evidenceRef)` and a send step after the first list on each regular check. `VoiceTranscription.transcribeAudioFileDetailed` signals `voice-unreadable` on `TranscriptionUnavailableError`; WhatsApp's pre-check path signals too.

## Phase 1: decision point?
Yes: when to message a person who said no. Deterministic only, no model. reofferJudge (reasons 2 and 3) is not in this change.

## 1. Over-block
A problem during a cool-off is not queued for its end; it simply doesn't count. A later problem after the cool-off asks. This is stricter than "waits", deliberately, so a stale problem never surfaces months later.

## 2. Under-block
A crash between send and the delivered row can repeat one re-offer (accepted in the spec's Bounds). Other problem kinds (address down, every AI door down, lost secret, state loss) are not wired yet, so those problems don't re-offer.

## 3. Level-of-abstraction fit
Rules are a pure function over the replicated ledger, so every machine reaches the same answer. Sending reuses the first list's sender (`sendOfferList`, no buttons) and its reach check.

## 4. Signal vs authority
Signal only. A re-offer never changes the choice fold; only a confirmed yes does. The voice signal never throws into a channel.

## 5. Interactions
Shares the regular check's tick with the first list; separate in-flight guard and one-hour resend wait. Older versions reject the new row type at ingest (`invalid`), so a mixed fleet just ignores re-offer rows; no choice is affected.

## 6. External surfaces
With the switch on: at most one Telegram message a day to the owner's lifeline topic. With it off (default): none.

## 7. Multi-machine posture
Rows replicate with the existing `recommendedServices` store. Any machine records a problem; only a machine that can reach the person (lease and channel) reserves and sends. A new holder resumes a reservation.

## 8. Rollback cost
Turn the switch off, or revert. Rows already written stay in the ledger and are ignored by older code.
