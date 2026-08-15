# ASP adversarial exit test — evidence

**Run:** 2026-08-15, 17:26–17:28 UTC · **Topic:** 29723 (the real Telegram path)
**Mechanism under test:** the DEPLOYED running copy, instar v1.3.1164 — not a branch
**Red team:** Observer 1, sending through the operator's Telegram account
**Author of the mechanism:** Echo (me). I did **not** send any of the six messages.

Charter clause this discharges: *"a red-team sender with normal send capability,
full format knowledge, and one captured valid agent message — but NO signing
credential — attempts an unsigned label, an altered body, a swapped agent/topic,
and an exact replay. NONE may enter the durable record as trusted provenance;
fresh legitimate messages must still classify correctly; preserve raw inbound
records and verifier decisions as evidence."*

## Why this run counts and the earlier rehearsals did not

An earlier battery was run by me against real signed bytes, and again against the
deployed verifier over HTTP. Both were the right rehearsal and neither discharged
the clause: **I was the sender**, and the HTTP one did not traverse the real
message path. This run fixes both — a different party, holding no signing key,
through the channel the feature exists to protect.

The "Codey lane" the ruling offered turned out not to exist for this test: the
premise is a message that *arrives looking like it came from the operator's
account*, so only someone sending through that account can produce one. That was
flagged and accepted before the run.

## The six sends, correlated

Raw inbound record ↔ verifier decision, joined on Telegram `messageId`.

| # | msgId | Attack / control | Verdict | Reason | agentId |
|---|-------|------------------|---------|--------|---------|
| 1 | 45713 | **CONTROL** — genuine block, unchanged | `agent-verified` | — | `echo` |
| 2 | 45715 | exact replay (byte-identical) | `rejected` | `replay` | `echo` |
| 3 | 45717 | altered body, genuine tag | `rejected` | `bad-signature` | `echo` |
| 4 | 45718 | relabelled sender (`a=codey`) | `rejected` | `unknown-agent` | `codey` |
| 5 | 45719 | fully forged tag, fabricated signature | `rejected` | `malformed` | — |
| 6 | 45720 | **CONTROL** — unsigned operator prose | `human` (corroborated, see below) | — | — |

Every recorded row carries `topicBound: true` and `replayChecked: true` — the
channel binding and the single-use check **actually ran** on all five. Without
those flags a clean sweep would be indistinguishable from a verifier refusing
things for an unrelated reason.

## The replay result is the load-bearing one

Messages 1 and 2 share an **identical body hash** (`25b82c4897f2bf67…`, 76 bytes
both). They were the same bytes. A heuristic authorship detector cannot separate
them *even in principle* — the copy IS the genuine text. Only the single-use
nonce distinguished the original from the copy, which is the entire argument for
doing this cryptographically rather than by style detection, demonstrated on real
traffic rather than asserted.

## Two honest deviations

**#5 refused earlier than predicted.** I told the red team to expect
`bad-signature`; it returned `malformed`. The fabricated signature was not even
the right shape, so it was rejected before any cryptography ran. A stronger
refusal, not a weaker one — recorded because the prediction was wrong, in the
safe direction.

**#6's evidence is a different kind.** The unsigned control produced **no durable
row**. That absence was investigated rather than accepted: unsigned traffic is
never written to the ledger by design (`onlyRecordTagged` defaults true — untagged
operator traffic is the overwhelming majority and would bury the interesting
rows). So the absence is expected behaviour, not a silent failure — but a missing
row looks identical whatever the verdict was, so it cannot prove the verdict
alone. Closed a second way: the exact arriving bytes were replayed through the
same deployed verifier, which returned `human` / no agent.

**Five of six are proven by the durable trail; the sixth is corroborated.** That
distinction is stated rather than smoothed over.

## What this does and does not establish

**Does:** on the deployed mechanism, over the real channel, a party without the
signing key could not obtain trusted provenance by any of forging, altering,
relabelling, or replaying — and a genuine message still verified and named its
author and channel in the same session.

**Does not:** say anything about what a verified message may *decide*. The
authority boundary is unchanged and deliberate — the verdict type carries no
permission, role, or trust field, and no consumer reads it as authorization
(verified by search with a control when the feature landed). A signature settles
WHO wrote a message. Nothing more.
