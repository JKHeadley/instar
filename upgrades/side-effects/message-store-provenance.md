# Side-Effects Review — Telegram message-store provenance

**Version / slug:** `message-store-provenance`
**Date:** `2026-07-31`
**Author:** `Instar-codey`
**Second-pass reviewer:** `Codex independent reviewer — concurred after remediation`

## Summary of the change

This change adds an additive `provenance` field (`user | agent | automation`) to new Telegram message-log rows. `TelegramAdapter` stamps inbound and direct-send rows, the real `/telegram/reply` route stamps conversational versus automated output, `TelegramRelay` carries the value across a tokenless-standby hop, and the shared logger/event callback paths preserve it. Presence, coherence, and commitment consumers use structural automation provenance while retaining legacy behavior for rows with no field. Historical rows are left byte-for-byte unchanged.

## Decision-point inventory

- `POST /telegram/reply/:topicId` classification — **add** — derives an outbound row's structural origin from the trusted send path and validated message-kind/relay metadata; it does not block or alter delivery.
- `PresenceProxy` log race guard — **modify** — automation rows cannot count as a substantive agent response; legacy rows retain the existing text-prefix fallback.
- `CoherenceMonitor` output scan — **modify** — structurally automated rows are excluded from the agent-output sample; legacy outbound rows remain included.
- `CommitmentSentinel` conversation pairing — **modify** — structurally automated rows are skipped between a user request and its conversational reply, while a new user row closes the candidate pair; legacy outbound rows retain the old behavior.

---

## 1. Over-block

Message delivery has no new block/allow branch. A producer that incorrectly stamps genuine agent prose as `automation` could cause the three migrated observers to miss that row. The production classification is centralized at the reply route and the adapter defaults only non-route/direct sends to automation; route and relay integration tests cover the named boundaries.

---

## 2. Under-block

Message delivery is unaffected. Legacy rows omit provenance, so readers deliberately retain their former heuristic or direction-only behavior for those rows; historical false counts are not retroactively repaired. Other platforms are not relabeled by this Telegram-specific change. A trusted internal caller that supplies incorrect relay metadata can still misclassify an outbound row, but cannot classify it as inbound `user`.

---

## 3. Level-of-abstraction fit

The writer seam is the right layer because it knows whether a message arrived from Telegram, passed through the conversational reply route, or originated as a direct server send. The cross-machine relay transports that already-made classification instead of reconstructing it from text on the holder. Consumers read the structural value and use compatibility logic only when the value is absent.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The closed provenance enum is structural metadata, not a judgment about message meaning. It neither blocks delivery nor overrides the outbound tone authority. Downstream monitors use it to avoid attributing automation to the conversational agent.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

This adds structural classification in an enumerable domain, rather than a static heuristic at a competing-signals judgment point. The three inputs are authenticated inbound platform traffic, ordinary conversational reply traffic, and server automation. Legacy unknowns remain unknown and use existing compatibility behavior rather than receiving a guessed label.

---

## 5. Interactions

- **Shadowing:** the reply route computes provenance after existing kind/proxy/system-template parsing and passes it alongside, not ahead of, tone-gate authority. It cannot shadow delivery checks.
- **Double-fire:** a relayed send is logged on each participating machine's local history as before; the new field is carried so both records agree. No extra send or callback is introduced.
- **Races:** provenance is immutable call data attached to the same append operation as the message. It adds no mutable shared state or asynchronous lookup.
- **Feedback loops:** PresenceProxy stops treating automation as a reply, which prevents an automated notice from canceling its own waiting tier. Brief agent acknowledgments remain non-cancelling. Commitment pairing skips intervening automation but stops at the next user message, preventing cross-request pairing. Commitment and coherence changes are read-only observations and emit no new action loop.

---

## 6. External surfaces

The persistent `telegram-messages.jsonl` schema gains one additive field on new rows. Internal callbacks and messaging events expose the same optional field. Existing rows, external readers, and non-Telegram loggers remain valid because the shared type treats omission as legacy/unknown. Telegram delivery bytes, timing, topic routing, and user-visible message text do not change. This patch adds no operator-facing action or mobile surface.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated in transit.** A tokenless standby passes provenance through `TelegramRelay` to the Telegram-owning holder, and both adapter logs persist the same value. The field rides the existing authenticated reply relay and requires no new replicated store. This change emits no new user-facing notice, holds no new independently mutable durable state, does not affect topic transfer, and generates no URLs.

---

## 8. Rollback cost

Hot-fix rollback is a code revert and patch release. Data migration and agent-state repair are unnecessary: additive fields on rows written during the rollout remain harmless to old readers, and legacy-compatible readers already accept omission. Rolling back temporarily restores prefix-based ambiguity for new outbound rows but does not corrupt delivery or history.

---

## Conclusion

The review found three material safeguards to make explicit: classify only at transport seams, default direct sends to automation, and transport the label across the multi-machine relay. The independent pass then found two gaps: metadata-less sentinel notices and commitment pairing across intervening automation. Both are now resolved with explicit sentinel provenance, bounded skip-to-reply pairing, and regression tests.

---

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer
**Independent read of the artifact:** Concur with the review — the two sentinel send seams now stamp automation explicitly, bounded pairing crosses automation without crossing a new user turn, and focused provenance/relay/legacy tests pass.

---

## Evidence pointers

- `tests/unit/telegram-messaging.test.ts` — direct-send automation, explicit agent reply, and inbound user rows.
- `tests/integration/telegram-message-provenance-route.test.ts` — real reply-route classification and outbound-user rejection.
- `tests/unit/relay-kind-forward.test.ts` — relay-hop provenance preservation.
- `tests/integration/shared-infra-delegation.test.ts` — legacy/shared logger persistence parity.

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, reason: this changes only the structural input classification consumed by existing monitors; it adds no self-triggered action, cadence, retry, notification, steady-state edge, or settling behavior.
