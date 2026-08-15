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

`FileSeenNonceStore` provides durable, restart-surviving replay defence. It
**fails closed on damage**: a corrupt or unreadable store throws rather than
starting empty, because an empty store accepts every replay — a silently
disarmed guard is worse than a loud failure. A *missing* file is still a
legitimate first run. `MemorySeenNonceStore` remains for tests and single-process
callers and is explicitly not durable.

## Evidence

- 24 unit tests, including the full adversarial battery and controls.
- Controls are load-bearing: a verifier that rejected *everything* would pass
  every adversarial assertion, so the suite also asserts that fresh legitimate
  agent messages verify and operator prose still classifies as `human`.
- Mutation check: forcing the signature check to pass kills 5 tests.
- Live path (topic 29723): signed with the real agent identity (public
  fingerprint `63b1dbb21646e2f5`, matching the published routing fingerprint),
  sent through the real relay. Sent bytes and recorded bytes are byte-identical
  (SHA-256 match), and the recorded copy classifies `agent-verified`. All four
  attacks were then run against those real bytes and all four were rejected.

  **Scope of that proof, corrected.** The body used was PLAIN TEXT, which is a
  *fixed point* of the Telegram markdown formatter — so the byte-identical result
  was guaranteed by the choice of input rather than earned by the mechanism. It
  certifies "a plain-text signed message survives the real path", NOT "signed
  messages survive the real path". See the formatting boundary below.

## The formatting boundary — a known, tested limitation

**A signature covers BYTES, so any transform between signing and transmission
breaks it.**

The Telegram send path runs `formatForTelegram`, which rewrites markdown to HTML:
`**bold**` becomes `<b>bold</b>`, a markdown link becomes an `<a href>`. A signed
body containing markdown therefore arrives with different bytes than were signed,
the body hash disagrees, and a **genuine agent message is classified
`bad-signature`** — a false rejection.

Measured: a 251-byte signed message became 280 bytes through the formatter and
flipped from `agent-verified` to `rejected`. The tag itself survives intact — the
damage is confined to the body, which is why the failure is `bad-signature` rather
than `malformed`.

**The fix is ordering, not cryptography: sign the bytes that will actually be
sent.** Either sign at the egress boundary (after formatting), or send signed
messages in a byte-preserving mode. `tests/unit/asp-formatting-boundary.test.ts`
pins all of this, including a passing test showing that signing the
already-formatted text verifies — so the fix has a target to satisfy rather than a
description to follow.

**Until that lands, signed messages must be plain text.** This is the reason
automatic outbound signing is not enabled: turning it on before the boundary is
resolved would produce false rejections on ordinary formatted messages.

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /provenance` | status: agent id, public fingerprint, whether replay defence is durable |
| `POST /provenance/verify` | classify raw bytes; reports which guards actually ran |

There is deliberately **no sign-on-demand route**. One would let anyone holding
the bearer token mint messages attributed to this agent — precisely the forgery
this mechanism exists to prevent. A test asserts those paths 404.

`GET /provenance` degrades honestly: with no identity on disk it answers `200`
with `enabled: false` rather than 404, so a probe can distinguish "off" from
"absent"; and a nonce store that fails to open reports
`replayDefence: "unavailable"` rather than running silently without it.

## Inbound classification

`AspInboundClassifier` chains onto the existing `onMessageLogged` seam (the one
Usher and TopicIntentCapture already use), so every inbound message is
classified without touching the hot path's control flow. Verdicts append to
`asp-classifications.jsonl`.

**Signal-only and unable to break delivery.** It never blocks, rewrites or drops
a message and never throws into the message path — a provenance recorder that
can break message delivery is a worse problem than the one it solves. Resolver
failures, an unwritable ledger and malformed entries are counted and swallowed.

The ledger stores the body **hash and length, never the body**: an audit trail
without copying conversation content into a second file. Untagged operator
traffic is classified but not recorded by default, so the interesting rows are
not buried under the overwhelming majority case.

## Key directory and what "verified" is worth

`AspKeyDirectory` resolves peers from the threadline discovery cache, so agents
other than self are verifiable. Self is authoritative and is never displaced by
a peer entry — otherwise anyone able to write that cache could impersonate *us*
to our own verifier.

**A resolved key proves the signer holds that key. It does not prove the key
belongs to the real peer.** That binding is made by the pairing/SAS layer, where
a human compares words out of band. The directory therefore reports a `trust`
source with every resolution: `self`, `mutual-verified`, or `discovery`.
`discovery` is good enough to tell agents apart and reject forgeries; it is not
good enough to stake a human-consequential decision on. Conflating the two is
the failure this field exists to prevent — and note that even `mutual-verified`
settles identity, never authority.

## Not yet done

- **Not deployed.** Everything above is committed on a branch. The running agent
  does not have it: `GET /provenance` answers 404 there and no classification
  ledger exists. Between "committed" and "running" sit a merge, a publish and a
  restart. **"Built" is the honest word until those happen.**
- **Speaker-label integration** — the `renderSpeakerLabel` seam lives in the
  uncommitted authorship-provenance worktree at the operator's approval gate and
  was deliberately not disturbed.
- **No outbound auto-signing.** Agents must call `signMessage` explicitly; the
  relay does not yet sign automatically, so unsigned agent traffic still exists
  and still relies on the heuristic layer.

## Test evidence (three tiers, per the Testing Integrity Standard)

| Tier | File | Count |
|---|---|---|
| Unit | `tests/unit/agent-signature-provenance.test.ts` | 24 |
| Unit | `tests/unit/asp-nonce-store.test.ts` | 10 |
| Unit | `tests/unit/asp-inbound-classifier.test.ts` | 11 |
| Unit | `tests/unit/asp-key-directory.test.ts` | 10 |
| Integration | `tests/integration/provenance-routes.test.ts` | 14 |
| E2E (alive) | `tests/e2e/agent-signature-provenance-alive.test.ts` | 8 |

The E2E tier is the one that catches a registration block that never runs: unit
and integration both pass even if `AgentServer` never mounts the routes.
