---
title: Agent-Signature Provenance
description: Agents sign the messages they send, so the infrastructure can tell your words from an agent's even when both arrive from your account -- and a forged, altered or replayed label is refused.
---

When an agent sends a message through your Telegram account, it arrives looking exactly like
something you typed. Nothing downstream can tell the difference. In one topic a prior
measurement found roughly **46% of messages that looked like the operator's were actually
agent-authored** -- so any reader, human or machine, that treats "came from his account" as
"he said it" is wrong about nearly half that traffic.

Agent-Signature Provenance closes that gap. An agent can attach a short signed tag to a
message; the infrastructure verifies it on the way back in and sorts every message into
exactly one of three buckets.

| Verdict | Meaning |
|---|---|
| `human` | no tag -- the account holder typed it |
| `agent-verified` | valid signature, naming the agent **and** the topic |
| `rejected` | a tag is present but not trustworthy |

Rejections are distinguishable rather than lumped together: `malformed`, `unknown-agent`,
`bad-signature`, `replay`, `stale`, `topic-mismatch`.

## Why a signature and not better guessing

Instar already has a heuristic authorship layer that flags messages *looking* agent-written
from style and context. It cannot reject an **exact replay**: a byte-identical copy of a
genuine agent message is, to any heuristic, genuine -- because it *is* the genuine text.
Only a signature bound to a single-use nonce separates the original from the copy.

This layer therefore **upgrades a suspected label into a proven one**. It does not replace
the heuristic, which still covers all unsigned agent traffic.

## The signer and verifier

`agentSignatureProvenance` holds the primitives. The signature covers a domain-separated
preimage binding the agent id, the topic id, a timestamp, a single-use nonce, and a SHA-256
of the message body -- so altering any one of them invalidates it. Fields are
charset-constrained so no field can contain the preimage separator, which makes the mapping
from fields to bytes injective and field-splicing impossible.

Two deliberate rules about where the tag may live:

- **Only the final line may be a tag.** A decoy tag earlier in the text stays inside the
  signed body, so adding one to a captured message breaks the hash.
- **Text appended after a genuine tag yields `human`, not `agent-verified`.** Attribution is
  lost rather than misapplied -- the safe direction.

## Replay defence that survives a restart

`FileSeenNonceStore` records which nonces have been used, on disk. A process-local store
would lose replay defence at every restart, and a restart is exactly when an attacker
holding a captured message would retry.

It **fails closed on damage**: a corrupt or unreadable store throws rather than starting
empty, because an empty store accepts every replay. A *missing* file is still a legitimate
first run. `MemorySeenNonceStore` remains available for tests and single-process callers and
is explicitly not durable.

Retention is bounded by the verifier's freshness window -- a tag older than the window is
rejected on age alone, so an aged-out nonce can be evicted without weakening the guarantee.

## Classifying what actually arrives

`AspInboundClassifier` chains onto the existing message-logging seam, so every inbound
message is classified without touching the hot path's control flow. Verdicts append to
`asp-classifications.jsonl`.

It is **signal-only and cannot break delivery**. It never blocks, delays, rewrites or drops
a message, and never throws into the message path -- a provenance recorder that can break
message delivery is a worse problem than the one it solves. Resolver failures, an unwritable
ledger and malformed entries are all counted and swallowed.

The ledger stores the body **hash and length, never the body**: an audit trail without
copying conversation content into a second file. Untagged operator traffic is classified but
not recorded by default, so the interesting rows are not buried under the majority case.

## Knowing which key belongs to whom

`AspKeyDirectory` resolves an agent id to the public key held for it, so signatures from
peers -- not just from self -- can be verified. Self stays authoritative and is never
displaced by a peer entry; otherwise anyone able to write the discovery cache could
impersonate *you* to your own verifier.

**A resolved key proves the signer holds that key. It does not prove the key belongs to the
real peer.** That binding is made by the pairing layer, where a human compares words out of
band. Every resolution therefore reports its `trust` source -- `self`, `mutual-verified`, or
`discovery` -- so the two cannot be quietly conflated. `discovery` is good enough to tell
agents apart and reject forgeries; it is not good enough to stake a human-consequential
decision on.

## Reading it

```bash
# Who does this agent sign as, and is replay defence durable?
curl -H "Authorization: Bearer $AUTH" http://localhost:4042/provenance

# Classify raw bytes
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  -d '{"raw":"<message text>","topicId":29723}' \
  http://localhost:4042/provenance/verify
```

`GET /provenance` degrades honestly: with no identity on disk it answers `200` with
`enabled: false` rather than 404, so a probe can distinguish "off" from "absent"; and a nonce
store that fails to open reports `replayDefence: "unavailable"` rather than running silently
without it.

There is deliberately **no sign-on-demand route**. One would let anyone holding the bearer
token mint messages attributed to this agent -- precisely the forgery the mechanism exists to
prevent.

## Provenance is not authority

A valid signature establishes **who wrote a message, never what it may decide.** The verdict
carries no permission, role or trust field, so a consumer cannot read an authorization out of
it. Wiring any capability to `agent-verified` would silently convert an identity check into
an authorization check -- the failure this boundary exists to prevent.

What an agent-authored message is *allowed to decide* remains a separate, separately recorded
decision.

## What it does not do yet

- **Outbound signing is not automatic.** Agents must sign explicitly, so unsigned agent
  traffic still classifies as `human` and still depends on the heuristic layer.
- Peer keys resolve through the local discovery cache, which proves key possession rather
  than peer identity (see above).
