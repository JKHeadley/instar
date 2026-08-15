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
- **The formatting boundary (found late, tested, unfixed).** The Telegram send
  path rewrites markdown to HTML, so a signed body containing markdown arrives
  with different bytes than were signed and a GENUINE message is rejected as
  `bad-signature`. Measured: 251 → 280 bytes, verdict flips. The original live
  proof missed it because plain text is a fixed point of the formatter — the
  control could not have said anything else. Pinned by
  `tests/unit/asp-formatting-boundary.test.ts`, including a passing test showing
  the correct fix (sign the already-formatted bytes). This is the concrete reason
  automatic outbound signing stays off: enabling it now would false-reject
  ordinary formatted messages.

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

## 5b. Declared silent fallbacks

The `no-silent-fallbacks` ratchet flagged 8 new error-swallowing catch blocks
over its 495 baseline. They are deliberate, and each is now annotated
`@silent-fallback-ok` with the reason and — more importantly — **which direction
it fails**:

| Site | Why it swallows | Direction of failure |
|---|---|---|
| classifier (4 sites) | signal-only: a provenance recorder that can throw into the message path is worse than the problem it solves | counted in `counters.errors`; message never blocked, delayed or dropped |
| key directory (3 sites) | a missing identity or damaged discovery cache means fewer known agents | toward **refusal** — unresolvable ids classify `unknown-agent` |
| nonce store parse | **not a swallow** — it rethrows as a named error | loudly, because an empty store accepts every replay |
| wiring (4 sites) | provenance must not stop the server or messaging stack booting | logged AND surfaced in the API (`replayDefence: "unavailable"`, `enabled: false` at 200) |

The baseline was **not** raised. Raising it would have recorded "8 more swallows
exist somewhere" and lost the reasons; annotating records why each one is correct
and leaves the ratchet able to catch the next undeclared one. Two tests assert
the classifier's swallowing property directly ("does not throw when the resolver
throws", "the chained handler never throws either"), so the claim is enforced
rather than asserted.

## 6. Reversibility

Fully reversible. Removing the `onMessageLogged` chain stops classification; the
two state files are inert data. No schema migration, no change to existing
records, no config keys added. Unsigned traffic behaves exactly as before.
