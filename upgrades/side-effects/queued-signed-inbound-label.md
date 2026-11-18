# Side-Effects Review — A queued or forwarded agent-signed message keeps its agent label (SEC-106)

**Version / slug:** `queued-signed-inbound-label`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `Independent Claude reviewer (fresh context, artifact + diff; see below)`

## Summary of the change

Spec: `docs/specs/queued-signed-inbound-label.md` (converged in 7 rounds, approved). The ASP agent label (`from agent <id> (signed) via <human>'s account`) was applied only on the live inject path. This change decides it once at Telegram ingress from the classifier's own verdict and carries it, as an optional `signedByAgent` field on the three sender-envelope types (`SessionRouter.ts`, `PendingInboundStore.ts`, `MessageProcessingLedger.ts`), to every delivery: queue-drain inject (A), queue-drain spawn/respawn (B), live spawn/respawn (C), the mesh owner's inject / spawn / dashboard-start waiter (D), and stuck-message replay (F). The classifier (`AspInboundClassifier.ts`) now stores a text hash with each verdict, never downgrades a resident `agent-verified` verdict for identical text, skips native-app entries, and answers reads only for the same text (`lookupVerdict`/`verdictFor` take a hash). `signedInbound.ts` gains `aspClassifiedText`, `labelFromEnvelope`, `framingLabel` (per-path counters), and `reconcileSignedLabel`. The lifeline route (`routes.ts`) writes the label into the processing-ledger row it creates, copies a reclaimed row's label (input match only) into `metadata.ledgerSignedByAgent`, and gates its own operator bind on classifier-or-ledger. Ingress (`server.ts`) reconciles classifier and carried labels (any source wins; disagreement counted), strips the in-process carriers, and never auto-binds a replay. `spawnSessionForTopic` takes an opt-in `firstMessageLabel` (and `recoveryPreamble`); unlabelled output is byte-identical. Counters appear in the authed `/health` as `signedInboundLabel`.

## Decision-point inventory

- Ingress label (server.ts onTopicMessage): text-bound classifier read + carried ledger/replay label → `metadata.signedByAgent` — modify.
- Ingress operator auto-bind: adds `!isReplay`; the reconciled label now also blocks — modify (more refusal only).
- Lifeline route operator auto-bind: `classifier ?? ledgerLabel` — modify (more refusal only).
- Classifier `remember`: same-text no-downgrade; app entries skipped — modify.
- Framing at A/B/C/D/F — add (label text only; no gate).

## 1. Over-block

No message is blocked, delayed or dropped anywhere. The only refusal is operator auto-bind, which is now withheld in two more cases: a replay (any replay, labelled or not), and a reclaimed row whose ledger copy says agent-written. A replayed genuine human message therefore no longer refreshes the topic operator binding; the original delivery already bound it, so the operator stays bound. A human message whose (topic, id) key is reused by a later, different message is never mislabelled: reads are text-bound.

## 2. Under-block

Residuals named in the spec: rows enqueued before this change and forwards from older peers carry no field (today's behaviour until they drain / the pool updates); the mesh owner records a ledger row only for numeric ids (fb-b017cbbd-638); a signed message with a file, stuck, then re-forwarded after a restart by a lifeline upgraded in between composes different text, so neither the ledger copy (input mismatch) nor the classifier (used nonce) labels it and the route could bind. On the polling path the ingress read now depends on rebuilding the logged text from `content` + `metadata.media`; a drift there would read as unlabelled and is visible as `hashMismatch` (pinned by the parity tests built from real Messages).

## 3. Level-of-abstraction fit

The label is decided at the one ingress convergence point and only carried afterwards; the classifier stays the single verifier. Every framing site goes through `framingLabel`, so counting and validation cannot be skipped by a path. The envelope helper `telegramSenderEnvelope` replaces four hand-built envelopes.

## 4. Signal vs authority compliance

The label is signal: it changes how the session is told who wrote a message. Its only authority effect is withholding operator auto-bind (caution, never grant). No wire body can set `replay`, `replaySignedByAgent` or `ledgerSignedByAgent` (fixed-metadata builders); if one could, the worst outcome is a message read as agent-written or a skipped bind. A paired peer can set the envelope field — no new reach (it already controls payload and sender, SEC-042).

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points: every decision is hash equality, a closed verdict set, or a boolean (label present / replay). Classified as invariants in the spec with basis and evidence.

## 5. Interactions

- `appendToLog` dedupe means a re-forward usually does not re-classify; when it does (restart), decision 5 prevents a same-text downgrade.
- The ingress block now strips `ledgerSignedByAgent` / `replaySignedByAgent`; nothing else reads them.
- `respawnSessionForTopic` with a label passes the recovery prompt separately; without a label the joined string is unchanged. A preamble with no usable label is joined as before, never lost.
- `PendingInjectStore` stores composed text, so a labelled first message survives boot recovery unchanged.
- `MessageProcessingLedger.claimForwardedInbound` gains an optional sender; existing callers are unchanged.

## 6. External surfaces

- Session-visible text: labelled messages on A/B/C/D/F now carry the agent tag and, for spawned sessions, the heading `The latest message (written by agent <id>, sent through <name>'s account):` and the reference line `... and the latest message, written by agent <id> (signed)`. Unlabelled text is byte-identical.
- D sites now also pass the forwarded sender's first name and user id to the tag (previously missing), so a moved session reads the sender as the receiving machine's live path does.
- Authed `/health` gains `signedInboundLabel` (counts only; the unauthenticated `/health` is unchanged).
- The mesh envelope may carry the new optional field; older receivers ignore it.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface changes. The only new text is session-facing framing and counters on the authed health endpoint.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated with the message: the label is decided on the classifying machine and travels in the envelope over the existing signed mesh `deliverMessage` command (and in the owner's ledger row). Mixed versions degrade to today's behaviour in both directions. Counters are per machine; no pool-wide sum is claimed.

## 8. Rollback cost

Revert the PR. The extra JSON field in stored queue/ledger rows is ignored by older code; no migration, no state repair.

## Conclusion

The change carries an existing, verified signal through every delivery path without adding authority. The tests pin the reader, the writers, every framing site, the reconciliation, replay never binding, the ledger copy, and text-hash parity from real polling and lifeline Messages.

---

## Second-pass review (if required)

**Reviewer:** Independent Claude reviewer (fresh context, read-only, spec + artifact + diff)
**Independent read of the artifact:** Concur with the review. Verified: only the four named writers put `signedByAgent` into an envelope; neither content nor a wire body can mint a label or the in-process carriers (every `onTopicMessage` builder uses fixed metadata; `replay` is set only by stuck replay); ingress reconciliation lets any source win, honours `replaySignedByAgent` only on a replay, strips both carriers, never labels app messages, and never auto-binds a replay; the route's bind is stricter than before; every classifier read is text-bound; unlabelled spawn output is byte-identical and the recovery text is never lost or labelled; path D has no use-before-definition. Named trade-off (accepted in spec decision 5a): a text-derivation drift reads as unlabelled, alarmed by `hashMismatch`.
Three non-blocking notes, all fixed before commit: (1) `firstMessageLabelParts` now cleans the sender name with `sanitizeSenderName`, as the inject path does, so a name holding `]` cannot fake the frame (test added); (2) `hashMismatch` is counted once per message (route reads pass `count: false`); (3) an invalid carried label is counted under `invalid`, not `delivered` (framing counts from the raw source value; test added).

---

## Evidence pointers

- `tests/unit/sec106-signed-label-carry.test.ts` (new)
- `tests/unit/asp-inbound-classifier-verdictFor.test.ts` (text-bound reads, no-downgrade, app skip)
- `tests/unit/signed-inbound-label.test.ts` (updated to the text-bound read)
- `tests/unit/session-pool-activation-wiring.test.ts` (D-site pin updated)
- `tests/unit/topic-operator-polling-bind.test.ts`, `tests/unit/redelivery-marker.test.ts` (unchanged, green)

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change fixes routing code (TypeScript source), not an LLM prompt, hook, config, skill, or standards text, and it adds no self-triggered controller: nothing here fires a restart, swap, respawn, spawn, notify, retry, re-drive, or kill on its own.
