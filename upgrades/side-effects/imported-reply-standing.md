# Side-Effects Review — a queued session reply keeps its reply standing when recovery imports it

**Version / slug:** `imported-reply-standing`
**Date:** `2026-11-07`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1. Two conditions in `src/messaging/telegram-origin/TelegramOriginService.ts`, one SQL literal in `src/messaging/telegram-origin/OriginStoreBackend.ts`, three tests in `tests/unit/telegram-origin/origin-service.test.ts`. Feedback fb-4fef846e-92e: a reply a session wrote with the reply script, refused with a retryable 503 and queued, was imported by recovery as `imported-legacy`; the last-hop notification gate granted the reply floor only to `producerKind === 'session'`, so the imported reply was routed as an automated notice, recorded in the quiet feed, and never sent. 12 real replies were lost between 2026-11-06 15:50Z and 2026-11-07 18:43Z. Now an imported row whose attribution names a live session gets the same verified-reply envelope a direct session send gets, minted at preparation (before the gate's hub redirect and before the record is sealed). Job sessions are excluded by the server's session record, as before. An imported row with no attributed session stays automated, and the last-hop classifier additionally refuses the reply floor to any imported record that names no session. The queue entry of a quietly recorded origin send is now labelled `quiet-recorded` instead of `delivered-tone-gated`.

Change size: 3 files, about 25 source lines and 70 test lines. Effort: no spec rounds (Tier 1); one commit attempt expected.

## Decision-point inventory

- `TelegramOriginService.notificationForCurrentProducer` (which envelope a prepared send carries) — modify — the reply floor now also covers an `imported-legacy` producer with a non-null `sessionId`; an ambient notification scope is ignored for imported rows.
- `TelegramOriginService.classifyPreparedNotification` (last-hop reply floor restore) — modify — adds one refusal: an imported record with `sessionId === null` never regains the floor from a sealed `verified-reply` origin.
- `OriginStoreBackend.recordOperationState` (entry label on quiet suppression) — modify — label only, no decision.
- `NotificationSelectivityGate.route` / `destination` — pass-through, unchanged.
- `OriginSessionRegistry.attributeVerifier` / `TelegramOriginService.attributeLegacy` — pass-through, unchanged; this is the proof the change relies on.

---

## 1. Over-block

This change removes an over-block: a genuine session reply is no longer filed quietly because it went through the queue. Remaining refusals on the import path are unchanged: a row with no credential digest (older script), an unmatched digest, or a session that has since ended stays automated and is recorded quietly rather than sent. Such a row from a real session is still lost as a reply, exactly as today; the row carries no other proof of its author, and inventing one would reopen the disguise hole (notification-selectivity spec §2.2). A job session's queued row stays quiet, as required.

---

## 2. Under-block

The proof is the SHA-256 digest of the session's origin credential, matched by the registry in constant time against the verifier it stored at issue time for a still-live session. Residuals:

- A process on the same machine that can read another session's environment (the raw credential) or the registry file (the stored digests) can write a row that attributes to that session. That process could equally run the reply script with that session's credential and send directly, so the import path grants nothing the direct path does not already grant. This is the same-machine trust boundary every origin funnel uses.
- A session's own queued reply that was written while the session had a job (`jobSlug` in the server's session record) is excluded; a session whose job assignment changed between enqueue and import is judged by its record at import time. Not observed in practice.
- Replies already suppressed before this change are terminal (durable quiet receipts are never resurrected); they are not recovered by this change.

---

## 3. Level-of-abstraction fit

The floor is granted where the producer and its attribution are both in hand, `notificationForCurrentProducer`, which is the single place that already decides the envelope for direct session sends. Granting it later, at the last hop, would be too late: `prepareBot` asks the gate for a push destination before sealing, and an automated envelope would already have moved the reply to the hub topic. The last-hop fence is a one-line guard in the function that already restores the floor from sealed bytes. No new module.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The change adjusts which envelope the existing `NotificationSelectivityGate` receives; the gate keeps its authority over delivery and recording. The one new refusal (imported record with no session never gets the floor) is a hard invariant of provenance, not a content judgment.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Does the sealed record name a session that recovery verified?" is an enumerable invariant (yes or no), not a judgment.

---

## 5. Interactions

- **Shadowing:** `destination()` runs at preparation and `route()` at the last hop; both now see a verified-reply envelope for an attributed import, so neither redirects nor records it. Before, both saw automated.
- **Double-fire:** none. The reply floor is minted once at preparation and restored once at the last hop, as for direct session sends.
- **Races:** attribution happens before the row is imported (same as today). A session that ends between attribution and the last hop keeps its sealed `sessionId`; the last hop re-checks only the job exclusion, as it does for a direct send whose session has since ended.
- **`completeNotification`:** a delivered imported reply now marks the topic answered, as a direct reply does. Before, an imported reply (recorded quietly) never did; this is the correct direction.
- **Ambient scope:** `prepareImportedLegacy` runs inside `importLegacyQueue`, which never sets a notification scope today; ignoring the ambient scope for imported rows closes the path where a future caller's scope would re-create this bug.
- **Entry label:** only origin-owned entries (`entry_kind = 'telegram-origin'`) are relabelled. The delivery sentinel drains `legacy` entries only, so it never reads this state; `ReapNoticeDrain` already uses `quiet-recorded` for the same meaning.
- **PR 2919** (`QueuedReplySupersession.ts`) bounds the peer wait on retried session replies; it does not touch the two functions changed here and no file overlaps.

---

## 6. External surfaces

A queued reply from a real session now reaches Telegram in its original topic, where before it did not. No route, config, or message format changes. The dashboard's queue view will show `quiet-recorded` instead of `delivered-tone-gated` for quietly recorded origin sends; nothing parses that label (verified by search: the only readers of `delivered-tone-gated` are the sentinel's own transition for its tone-gate path and a type union). No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the legacy queue lives in this machine's state, the credential digest is matched against this machine's registry, and the importing machine seals the record with its own key. A peer never imports another machine's queue. The delivered reply then follows the existing lease-holder egress path. No new durable state, no URLs. The user-facing notice is the reply itself, under the existing one-voice gating.

---

## 8. Rollback cost

One revert, no migration. Rows labelled `quiet-recorded` during the window are terminal either way; no reader distinguishes them from `delivered-tone-gated`.

---

## Conclusion

The review confirmed the fix must sit at preparation (the hub redirect happens before sealing) and added the last-hop fence so an unattributed import can never regain the floor from sealed bytes. Both sides of the decision are tested against the real store, registry and gate: an attributed session row sends in its own topic; a job-session row, a row without a digest, and a row with a foreign digest are recorded quietly with the entry labelled `quiet-recorded`; a reply claim on an unattributed record is refused at the last hop. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (2026-11-07)
**Independent read of the artifact: concur**

Concur with the review. The reviewer traced: the row carries only the credential digest and cannot mint a registry entry; a forged `sessionId` in the sealed record is refused at import by the store's digest and attestation checks; the only producer of an `imported-legacy` record is the runtime's import loop passing `attributeLegacy`; the classify-time fence bites only on an imported record with no session, so reply-route envelopes on session or server-automation records are untouched; both entry labels are already in the state union, the sentinel and purge queries select `legacy` entries only, and no dashboard file reads either literal; the job exclusion is applied on both the prepare and classify paths. One cosmetic note, not a block: the last-hop restore labels an attributed import `origin-session` / `relayed-origin-session` rather than `imported-origin-session`; behaviour is identical.

---

## Evidence pointers

- `tests/unit/telegram-origin/origin-service.test.ts` → "an imported queue row under the notification gate" (3 tests). On origin/main all three fail: the session row's record is automated, the entry reads `delivered-tone-gated`, and the forged claim resolves instead of being refused.
- Incident window from fb-4fef846e-92e: 12 replies, 2026-11-06 15:50Z to 2026-11-07 18:43Z, each ending `suppressed` / `quiet-notification-recorded` with the entry labelled `delivered-tone-gated`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in TypeScript delivery code, not a prompt, hook, config, skill, or standards text, and no self-triggered controller is added or modified (the recovery loop that retries queued rows is unchanged; only the envelope its rows carry changes).
