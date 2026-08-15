# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Agents can now sign the messages they send, so infrastructure can tell an
operator's own words from an agent's — even when both arrive from the same
account.

A signed message carries a short tag on its final line binding the agent id, the
topic, a timestamp, a single-use nonce, and a hash of the message body. Received
messages classify one of three ways, and only three:

| Verdict | Meaning |
|---|---|
| `human` | no tag — the account holder typed it |
| `agent-verified` | valid signature; names the agent AND the topic |
| `rejected` | a tag is present but not trustworthy |

Rejections are distinguishable: `malformed`, `unknown-agent`, `bad-signature`,
`replay`, `stale`, `topic-mismatch`.

**Why cryptographic rather than heuristic.** A style-based detector cannot reject
an exact replay: a byte-identical copy of a genuine agent message is, to any
heuristic, genuine — because it *is* the genuine text. Only a signature bound to
a single-use nonce separates the original from the copy. This upgrades a
*suspected* authorship label into a *proven* one; it does not replace the
heuristic layer, which still covers unsigned agent traffic.

**Authority boundary — deliberately unchanged.** A valid signature establishes
WHO wrote a message, never what it may DECIDE. The verdict type carries no
permission, role or trust field, so a consumer cannot read an authorization out
of it. Treating "signed by agent X" as authorization would be a defect.

## What to Tell Your User

- "I can now prove which messages from your account were written by an agent
  rather than by you."
- "A copied, altered, re-labelled or replayed message is refused, and the refusal
  is recorded with its reason."
- "This says who wrote something. It never says what they're allowed to decide."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Check this agent's signing identity and whether replay defence is durable | `GET /provenance` |
| Classify raw message bytes | `POST /provenance/verify` with `{raw, topicId}` |
| Automatic classification of inbound messages | Automatic after updating and restarting; verdicts append to `asp-classifications.jsonl` |
| Durable replay defence | Automatic; nonce state survives restarts |

There is deliberately **no sign-on-demand endpoint**. One would let anyone
holding the bearer token mint messages attributed to this agent — exactly the
forgery this prevents.

## Compatibility Notes

No configuration changes and no behaviour change for unsigned traffic: a message
with no tag classifies as `human`, which is what every existing message is.
Agents must call `signMessage` explicitly — outbound signing is not automatic, so
nothing starts appending tags on its own.

`GET /provenance` degrades honestly: with no identity on disk it answers `200`
with `enabled: false` rather than 404, so a probe can tell "off" from "absent". A
nonce store that fails to open reports `replayDefence: "unavailable"` rather than
running silently without replay defence.

Peers resolve through the existing Threadline discovery cache. A resolved key
proves the signer holds that key; it does not prove the key belongs to the real
peer — that binding is the pairing/SAS layer's job, and each resolution reports
its trust source (`self`, `mutual-verified`, `discovery`) so the two cannot be
conflated.

## Evidence

77 tests across all three tiers: 55 unit, 14 integration, 8 e2e. The e2e tier
boots a real `AgentServer` through the production initialization path and asserts
`GET /provenance` answers 200 — not 404 (never registered) and not 503
(registered but inert); unit and integration both pass even if the routes are
never mounted, which is the failure that tier exists to catch.

The adversarial battery — unsigned label, altered body, swapped agent, swapped
topic, exact replay — is rejected in tests and against real signed bytes on the
live Telegram path, where the sent bytes and the recorded bytes were verified
byte-identical by SHA-256 and the recorded copy classified `agent-verified`.

The checks are shown to be capable of failing: forcing the signature check to
always pass kills 5 tests, and two dependency controls demonstrate each
non-cryptographic guard carrying its own rejection — the attack *succeeds* when
its guard is omitted, so the adversarial tests provably measure those guards
rather than something else.

Replay defence is verified across a simulated restart using a second store
instance over the same file, with a control proving fresh messages still verify
afterwards (a store reporting every key as seen would otherwise pass).

TypeScript build and the complete repository lint suite pass.
