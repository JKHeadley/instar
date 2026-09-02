# Side-Effects Review — Agent-signed inbound messages are labelled, not laundered

**Version / slug:** `asp-signed-inbound-label`
**Date:** `2026-09-02`
**Author:** `Echo`
**Second-pass reviewer:** `Codex independent reviewer (see below)`

## Summary of the change

A message an agent signs and delivers through a human's Telegram account already receives an `agent-verified` verdict from the ASP inbound classifier, but that verdict lived only in a ledger. The receiving session was still told the message came `from <human>`, and the topic-operator auto-bind still seated that human as the topic's verified operator. This change reads the classifier's own verdict at the routing convergence point (`telegram.onTopicMessage` in `src/commands/server.ts`), by platform message id from in-process state, and does three things for a verified-signed message: the injection tag names the signing agent and the carrying account (`src/types/pipeline.ts`, `src/core/SessionManager.ts`), the thread-history renderers say the same via one shared label (`src/server/routes.ts`, `src/core/ForwardedTopicContext.ts`, `src/core/AspAuthorshipJoin.ts`), and operator auto-bind is refused. The classifier gains a bounded per-message verdict lookup (`src/core/AspInboundClassifier.ts`); the helpers live in `src/messaging/shared/signedInbound.ts`; the CLAUDE.md awareness bullet and its idempotent migration live in `src/core/PostUpdateMigrator.ts`.

## Decision-point inventory

- `telegram.onTopicMessage` operator auto-bind (`src/commands/server.ts`) — modify — the bind is additionally gated on "this message is not agent-signed"; every other condition is unchanged.
- Lifeline-forward operator auto-bind (`src/server/routes.ts`) — modify — the same gate, on the same cached verdict (the message is logged, and therefore classified, before this bind runs).
- `AspInboundClassifier.classify` — pass-through — unchanged verdict logic; it now also remembers each verdict by message id.
- `buildInjectionTag` / `injectTelegramMessage` — modify — an additive sender clause; no block/allow surface.
- Thread-history renderers — modify — label only; no block/allow surface.

---

## 1. Over-block

The only thing this change withholds is operator auto-bind, and only for a message whose signature the classifier verified as an agent's. A human's own message is never withheld: an unsigned message, a message with a malformed or forged tag (`rejected`), and a message the classifier never saw all keep today's auto-bind behaviour. Over-block would require the classifier to verify a signature a human typed — which requires the agent's private key. If a topic's very first message is agent-signed, that topic simply has no verified operator until the human writes; that is the correct state, not a regression.

## 2. Under-block

An agent that never signs its messages is still indistinguishable from the account holder (the ASP limit already stated in the awareness section). The durable inbound queue path (`dmsg.senderEnvelope`, ships dark) does not carry the flag yet, so a message delivered through that path would arrive with today's tag; it still cannot mis-bind, because the bind decision happens at the convergence point before either delivery path. A message classified before this process started (ledger only, no in-memory verdict) is labelled by the history join but injected with today's tag. Rejected-but-genuine signatures (the plain-text-only limit) fall to `human` behaviour, which is the pre-existing fail direction.

## 3. Level-of-abstraction fit

This is a low-level invariant at the identity layer, exactly where Know Your Principal says it belongs: the one place both ingress paths converge, reading the one cryptographic authority that already exists. It does not add a second verifier (the nonce is single-use, so it must not), and it does not add a judgment. The higher-level gate it feeds is the existing operator-binding path, which now has a truthful input.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface beyond withholding one automatic grant on cryptographic proof.

The label is a signal to the session. The one authority it exercises — refusing operator auto-bind — is deterministic on an exact, unforgeable match (a valid Ed25519 signature bound to a single-use nonce), which is the ruled shape for structure deciding alone. It never blocks, delays, rewrites, or drops a message; every failure path delivers the message unlabelled.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Was this message signed by an agent?" is enumerable (verified / not), and the auto-bind refusal is a safety guard on an identity grant, deterministic by design.

---

## 5. Interactions

- **Shadowing:** the verdict is read from the classifier, which runs on the `onMessageLogged` seam BEFORE routing on both ingress paths (polling: `appendToLog` precedes `onTopicMessage`; lifeline: `logInboundMessage` precedes the `onTopicMessage` fire in `routes.ts`). If logging is deduplicated for a repeated message id, the first verdict is reused, which is correct.
- **Double-fire:** none. The classifier still verifies exactly once; the routing path reads, never re-verifies (a second verify would classify the genuine message as a replay).
- **Races:** the in-memory map is written and read on the same event-loop turn sequence; bounded at 1000 entries with oldest-first eviction.
- **Feedback loops:** none. The label does not feed the classifier.
- The `routes.ts` lifeline-side operator bind runs BEFORE the convergence point, so gating only the convergence point would have left an agent-signed lifeline message able to seat the operator (raised by the second-pass reviewer). It is now gated on the same verdict, read through a context getter to the one classifier; the log call that classifies the message precedes it in the same handler.
- The convergence point OWNS `metadata.signedByAgent`: it is rewritten from the verdict on every message and removed when the verdict is not agent-verified, so a value arriving on the Message from a wire body, a replay, or a queue row can never reach the injection (also raised by the second-pass reviewer).

---

## 6. External surfaces

- Other agents on the same machine: none.
- Install base: every agent gets the labelling on the next server restart; the awareness bullet arrives through the CLAUDE.md migration.
- External systems: none. No Telegram send changes.
- Persistent state: none new. The ASP ledger format is unchanged; the history join reads it as before and adds a derived field.
- Timing: none.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read.** The verdict is machine-local by nature (the classifier on the receiving machine verifies the signature and holds the nonce store), and the label follows the message to whichever session is injected on that machine. For a topic that has moved, the forwarded thread history carries `authorship` and `authorshipAgentId` from the previous machine's history read, so the relayed history block shows the same label. It emits no user-facing notice, holds no durable state that could strand on transfer, and generates no URL.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state, no data migration. The awareness bullet would then overstate behaviour until a correcting migration lands; a rollback would carry one.

---

## Conclusion

The change closes a real identity-bleed path with the smallest possible authority: one deterministic refusal on cryptographic proof, and otherwise labels. The review moved the verdict lookup from "verify again at routing" (wrong: single-use nonce) to "remember the log-time verdict by message id", and added the charset sanitisation on the agent id so a ledger row can never inject text into a tag. Two honest limits are recorded above (dark inbound-queue path; lifeline-side first bind). Clear to ship after the independent second pass and the full test gate.

---

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer (GPT-5.6, read-only, artifact + diff)
**Independent read of the artifact:** concern on the first pass, both points accepted and fixed. (1) The lifeline-forward operator bind ran before the convergence point, so the claimed under-block protection did not hold for that ingress — now gated on the same verdict. (2) The injection trusted a pre-existing `metadata.signedByAgent` — the convergence point now rewrites the field from the verdict and strips any other value. The reviewer confirmed the auto-bind at the convergence point depends only on the classifier-derived value, that no second signature verification occurs, that the tag change is backward-compatible, and that the label grants no authority. Second pass on the revised diff (same reviewer, same read-only setup): **concur, no issues** — the lifeline-forward bind is gated on the cached verdict after the log call, the convergence point owns the metadata field, no second verification exists, and the label grants no authority.

---

## Evidence pointers

- `tests/unit/signed-inbound-label.test.ts`
- `tests/unit/asp-inbound-classifier-verdictFor.test.ts`
- `tests/unit/asp-authorship-join-agentid.test.ts`
- `tests/unit/PostUpdateMigrator-aspSignedInboundBullet.test.ts`
- `tests/unit/redelivery-marker.test.ts` (parameter-count guard updated with its reasoning)

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change fixes routing code (TypeScript source), not an LLM prompt, hook, config, skill, or standards text, and it adds no self-triggered controller: nothing here fires a restart, swap, respawn, spawn, notify, retry, re-drive, or kill on its own.
