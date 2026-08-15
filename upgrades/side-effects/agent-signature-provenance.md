# Side-Effects Review — Agent-Signature Provenance (ASP v1)

**Version / slug:** `agent-signature-provenance`
**Date:** `2026-08-15`
**Author:** `Instar-echo`
**Charter:** Window 16 · **Spec:** `docs/specs/agent-signature-provenance.md`

## Summary of the change

Adds an Ed25519 message-signing layer so agent-authored messages are
machine-distinguishable from operator-authored ones on the same account.

New modules: `src/core/agentSignatureProvenance.ts` (sign/verify + preimage),
`src/core/aspNonceStore.ts` (durable replay defence),
`src/core/AspInboundClassifier.ts` (classifies inbound, records verdicts),
`src/core/AspKeyDirectory.ts` (peer key resolution with trust source).
New routes: `GET /provenance`, `POST /provenance/verify`, registered in
`AgentServer`. The classifier is chained onto the existing `onMessageLogged`
seam in `src/commands/server.ts`.

## Decision-point inventory

- **Message delivery** — *pass-through*. The classifier is chained, never
  replacing, and swallows every failure. No message is blocked, delayed,
  rewritten or dropped.
- **Authorization decisions** — *untouched by construction*. The verdict type has
  no permission/role/trust field; a caller cannot derive an authorization from
  it. A test asserts those keys never appear in a response.
- **Signing authority** — *narrowed*. There is no route that signs on request, so
  bearer-token access cannot mint attributed messages.
- **Existing heuristic authorship layer** — *unchanged*. This adds a proof path
  above it; unsigned agent traffic still relies on the heuristic.

---

## 1. Over-block

Nothing new is blocked. The only refusals this introduces are *classification*
verdicts recorded in a ledger — a `rejected` verdict does not stop, delay or
alter delivery of the message it describes. The historically risky direction
(mis-attributing altered bytes to an agent) is deliberately resolved the safe
way: text appended after a genuine tag classifies as `human`, losing attribution
rather than misapplying it.

## 2. Under-block

The known gaps, stated rather than implied:

- **Unsigned agent traffic still classifies as `human`.** Outbound signing is not
  automatic, so an agent that does not call `signMessage` is indistinguishable
  from the operator by this layer. The heuristic layer remains the only cover
  there. This is the largest residual gap.
- **`discovery`-trust keys are not identity-verified.** A resolved key proves the
  signer holds it, not that it belongs to the real peer. The trust source is
  carried on every resolution precisely so a consumer cannot silently treat the
  two as equivalent.
- **Two local passes do not prove non-flakiness under CI conditions**; the test
  evidence is stated with that limit.

## 3. Failure modes

- **Corrupt nonce store** — fails CLOSED: it throws rather than starting empty,
  because an empty store accepts every replay. A *missing* file is still a
  legitimate first run. The construction path catches this and degrades to
  classification-without-replay-check, with `replayChecked: false` recorded on
  each row rather than a silent loss of the guard.
- **Unwritable ledger** — counted and swallowed; classification still succeeds.
- **Resolver throws** — counted and swallowed; no message-path impact.
- **No identity on disk** — the feature reports `enabled: false` at 200 rather
  than 404, so absence and disabled are distinguishable by a probe.

## 4. Data written

`asp-nonces.json` (nonce → expiry; bounded by the freshness window, hard cap
50,000 entries, soonest-to-expire evicted first) and `asp-classifications.jsonl`
(one row per tagged inbound message).

**The ledger stores the body HASH and byte length, never the body.** This gives
the audit trail the charter requires without copying conversation content into a
second file. Untagged operator traffic is classified but not recorded by default,
so the interesting rows are not buried under the majority case.

## 5. Secrets

The signing key never crosses an HTTP boundary. `GET /provenance` reports the
public fingerprint only. The server loads the PUBLIC key via `readRaw()` and
never decrypts the private key — these routes verify, they never sign, so an
encrypted identity needs no passphrase here. A test asserts no response contains
private key material, paired with a control asserting it *can* find the public
fingerprint, so a clean scan is a measurement rather than a broken search.

## 6. Reversibility

Fully reversible. Removing the `onMessageLogged` chain stops classification; the
two state files are inert data. No schema migration, no change to existing
records, no config keys added. Unsigned traffic behaves exactly as before.
