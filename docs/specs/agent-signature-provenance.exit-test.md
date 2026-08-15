# ASP adversarial exit test — runbook for a NON-AUTHOR red team

**Purpose:** discharge the Window 16 charter clause. This test is **not** satisfied
by the author's own rehearsal against the branch; it runs against the **deployed**
mechanism and is executed by someone who is not the author.

**Who runs it:** a Codey lane, or Observer 1 as the red-team hand. Not Echo.

**Preconditions (verify, do not assume):**

1. The change is merged, published, AND the running process restarted onto it.
   Confirm behaviourally, not by version string:
   ```bash
   curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/provenance
   ```
   Must return `200` with `enabled: true`. A `404` means the running copy does not
   have the feature — stop; the exit test cannot run.
2. The inbound classifier is live: `asp-classifications.jsonl` exists under the
   agent state dir and gains rows as messages arrive.

## What the red team is given, and what it is NOT

**Given:** normal send capability on the channel, full knowledge of the tag format
(it is documented and in the source), and **one captured valid agent message**
(copy any message from the topic that carries a `⟦asp1 …⟧` tag).

**NOT given:** the signing key. That is the whole experiment. If you find yourself
needing the key, the attack has already failed.

## The four attacks

Send each as a normal message. Then read the verdict from the classification
ledger (or `POST /provenance/verify` with the same bytes).

| # | Attack | How to construct it | Required verdict |
|---|---|---|---|
| 1 | **Unsigned label** | Write your own tag from scratch: `⟦asp1 a=echo t=<topic> ts=<now> n=redteam01 s=<86 chars of anything>⟧` on the final line | `rejected` / `bad-signature` |
| 2 | **Altered body** | Take the captured message, change one character of its text, keep its tag line verbatim | `rejected` / `bad-signature` |
| 3 | **Swapped agent** | Take the captured tag line and change `a=echo` to `a=codey` | `rejected` (`bad-signature` or `unknown-agent`) |
| 4 | **Exact replay** | Re-send the captured message byte-for-byte, unchanged | `rejected` / `replay` |

A fifth worth running if the topic allows: send the captured message into a
**different topic** unchanged — expect `rejected` / `topic-mismatch`.

## The controls — without these the test proves nothing

A verifier that rejected *everything* would pass all four attacks above. Both of
these must ALSO hold, in the same session, after the attacks:

- **A fresh genuine agent message still verifies** → `agent-verified`, naming the
  right agent and topic.
- **A message the operator types himself still reads as his** → `human`.

If either control fails, the mechanism is broken in the opposite direction and the
exit test has NOT passed, regardless of how cleanly the four attacks were refused.

## Evidence to preserve

The charter requires raw inbound records and verifier decisions kept as evidence:

- The raw inbound message records for all six sends (four attacks + two controls).
- The corresponding rows from `asp-classifications.jsonl` — each carries the
  verdict, the reason, a body hash, and which guards actually ran
  (`topicBound`, `replayChecked`).

Note the ledger stores a body **hash**, not the body, so the raw inbound record is
the other half of the evidence and must be captured separately.

## What a pass means, and what it does not

A pass means: with send capability, full format knowledge, and a captured valid
message, an attacker without the signing key could not get a forged, altered,
re-labelled or replayed message accepted as trusted provenance — on the deployed
system, verified by someone other than its author.

It does **not** mean unsigned agent traffic is attributed (it classifies as
`human` — outbound signing is not automatic), nor that a `discovery`-trust peer
key has been bound to a real-world identity.

## If an attack succeeds

Do not fix it quietly. Record which attack, the exact bytes sent, and the verdict
returned. A successful forgery against the deployed mechanism is a charter
failure, not a bug report — it means the clause is undischarged and the claim that
it passed would have been false.
