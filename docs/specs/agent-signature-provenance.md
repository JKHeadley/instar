# Agent-Signature Provenance (ASP v1)

**Status:** thin slice live on the real Telegram path (topic 29723), 2026-08-15.
**Charter:** Window 16. **Layer:** authentication of authorship. **Not:** authorization.

## The problem

A message from the operator's Telegram account is, by default, indistinguishable
from one an agent sent *through* that account. In Justin's words:

> "some official signature that agents/topics can send within messages that the
> infra can detect to recognize messages that are NOT me, even though they come
> from my account."

This matters beyond tidiness. A prior window measured that roughly **46% of
operator-attributed messages in one topic were agent-authored**. Any reader —
human or machine — that treats account identity as author identity is wrong
about nearly half that traffic.

## What it does

Agent-authored messages carry a signed tag on their final line:

```
⟦asp1 a=<agent> t=<topic> ts=<unix> n=<nonce> s=<ed25519-sig>⟧
```

The signature covers a domain-separated, newline-delimited preimage:

```
asp1 \n <agentId> \n <topicId> \n <timestamp> \n <nonce> \n sha256(body)
```

Three classifications, and only three:

| Verdict | Meaning | Charter case |
|---|---|---|
| `human` | no tag — the operator typed it | 1 |
| `agent-verified` | valid tag; names the agent AND topic | 2 |
| `rejected` | tag present but not trustworthy | 3 |

Rejection reasons are distinguishable: `malformed`, `unknown-agent`,
`bad-signature`, `replay`, `stale`, `topic-mismatch`.

## Why cryptographic rather than heuristic

The existing heuristic layer flags messages as *suspected* agent-authored from
style and context. It cannot reject an **exact replay**: a byte-identical copy of
a genuine agent message is, to any heuristic, genuine — because it *is* the
genuine text. Only a signature bound to a single-use nonce separates the original
from the copy.

ASP therefore **upgrades a suspected label into a proven one**. It does not
replace the heuristic, which still covers unsigned agent traffic. The intended
integration seam is the speaker-label renderer: a verified signature promotes a
hedged label to a definite one.

## AUTHORITY BOUNDARY — deliberately open

Per the standing ruling of 2026-08-14: **provenance never settles authority.**

This module answers exactly one question: *who authored these bytes?* It exposes
no permission, role, or trust level, and a caller cannot derive one from its
output. `agent-verified` means **authenticated, not authorized**.

**The open question, stated rather than resolved:** when a message is proven to
come from agent X, what — if anything — is X thereby permitted to decide? This
spec deliberately does not answer that. Answering it is a separate, separately
recorded decision, and wiring any capability to `agent-verified` without that
decision would silently convert an identity check into an authorization check.
That conversion is the failure mode this section exists to prevent.

A concrete guard: the module's return type has no field an authorization check
could read. Adding one is the tell that this boundary is being crossed.

## Threat model

The adversary has normal send capability on the channel, full knowledge of this
format, and one captured valid agent message. The adversary lacks the signing
key. Operator account access is *assumed* — the entire point is that account
access must not confer agent identity.

| Attack | Defence | Result |
|---|---|---|
| Unsigned / fabricated label | Ed25519 verification | `bad-signature` |
| Altered body, real tag | body hash inside preimage | `bad-signature` |
| Swapped agent | agentId inside preimage | `bad-signature` |
| Swapped topic | topicId in preimage + delivery binding | `topic-mismatch` |
| Exact replay | single-use nonce + freshness window | `replay` |

### Deliberate design choices

- **Only the final line may be a tag.** A decoy tag earlier in the text stays
  inside the signed body, so adding one to a captured message breaks the hash.
- **Text appended after a genuine tag yields `human`, not `agent-verified`.**
  Attribution is lost rather than misapplied — the safe direction.
- **Rejected tags never mutate nonce state**, so a forgery cannot burn a nonce
  the legitimate agent still needs (verified by test).
- **Freshness is checked before the nonce store**, which bounds how long nonces
  must be retained: a tag older than the window is rejected on age alone.
- **Charset-constrained fields** make the preimage injective — no field can
  contain the separator, so field-splicing cannot produce a collision.

## Wiring requirements (load-bearing, not optional)

Two guards live outside the signature and must be supplied by the caller:

1. **`seenNonces`** — without a durable store there is **no replay defence**.
2. **`expectedTopicId`** — without it there is **no channel binding**.

Both have dedicated tests that demonstrate the attack *succeeding* when the guard
is omitted, so the adversarial tests provably measure those guards.

A durable, restart-surviving nonce store is **not yet built** — `MemorySeenNonceStore`
is process-local. Until it exists, replay defence does not survive a restart.
This is a named gap, not an implied capability.

## Evidence

- 24 unit tests, including the full adversarial battery and controls.
- Controls are load-bearing: a verifier that rejected *everything* would pass
  every adversarial assertion, so the suite also asserts that fresh legitimate
  agent messages verify and operator prose still classifies as `human`.
- Mutation check: forcing the signature check to pass kills 5 tests.
- Live path (topic 29723): signed with the real agent identity (public
  fingerprint `63b1dbb21646e2f5`, matching the published routing fingerprint),
  sent through the real relay. Sent bytes and recorded bytes are **byte-identical**
  (SHA-256 match), and the recorded copy classifies `agent-verified`. All four
  attacks were then run against those real bytes and all four were rejected.

## Not yet done

- Durable nonce store (replay defence currently process-local).
- Inbound wiring: classification is not yet applied automatically to every
  received message, nor is the verdict yet written to the durable record.
- Integration and E2E tiers (required by the Testing Integrity Standard).
- Public-key directory for peers; the live slice resolves only self.
