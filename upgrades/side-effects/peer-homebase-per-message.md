# Side-Effects Review — judge every peer message "meant for the user?" (homebase posting)

**Version / slug:** `peer-homebase-per-message`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (changes message routing and adds an LLM judgment point). Implements spec §2.7: the
second half of the operator rule of 2026-10-31 ("all messages from an agent that are intended
for the user show up in that topic"). §2.6 (PR #2507, the base of this branch) posted only the
first message of each peer conversation, because the SalienceGate runs with no classifier.

New `PeerUserMeantJudge` (`src/threadline/PeerUserMeantJudge.ts`): deterministic protocol
exclusion by wire type (`ack`, `wellness`, the two fixed ack sentences) → Jev (TypeSafe) when
confident outside the shared cascade band → referee chain (Codex fast tier, then the shared
provider, so a Claude-only agent still judges) → no verdict = user-meant (post). A spent budget
(daily cap 300 model calls seeded from the log; 30 judged messages per peer per hour) returns
`firstOnly`, and the caller applies the §2.6 first-only rule. Content-free audit rows in
`logs/peer-user-meant.jsonl`; metered as `peer-user-meant`.

`PeerHomebaseRelay` uses it for every message (all three inbound seams pass the wire type),
lifts the per-thread minute for judged posts (the per-topic three-a-minute brake stays), retries
a judged post held by that brake or a failed send (max 2, max 50 pending), and records which
threads it owns. `TopicLinkageHandler` uses it only for a reply REDIRECTED to the homebase (6 s
budget). `ThreadlineRouter`'s spawn prompt says "the server already posts…, do not repost" only
for a thread the relay owns and that is unbound. Switch:
`threadline.peerHomebase.perMessageClassification` (read live; omitted = on; false = §2.6).
CLAUDE.md card updated with an in-place migration (new sniff marker).

## Decision-point inventory

- Whether the server posts a peer message to the homebase — modify — new per-message LLM judgment (Jev → referees), fail toward posting; deterministic protocol floor.
- Per-thread post brake — modify — not applied to judged posts; per-topic brake unchanged.
- Spawn-prompt instruction — modify — "do not repost" only where the relay owns the thread.

---

## 1. Over-block

Nothing is refused: every message still reaches its session, and the verdict only decides
whether a COPY is posted. The over-posting side: a no-verdict message is posted (by design), and
a wrong user-meant verdict buzzes the operator with agent chatter, bounded by three posts a
minute per topic and the judge's own budget.

## 2. Under-block

- A wrong agent-internal verdict means no server post; the session was told not to repost, so
  only its own words remain (the prompt invites it to add a point the user still needs).
- Past the daily cap / a peer's hourly limit, later messages fall back to first-only (session-reliant).
- One busy peer can spend the shared daily cap for every peer.
- A judged post that fails after its retries stays in the silent hub only.
- The spawn prompt is fixed at spawn: switching judging off later leaves a running session
  believing the server posts.
- A bound, non-operator conversation with no thread-resume entry is handled by neither path
  (pre-existing, unchanged).

## 3. Level-of-abstraction fit

The judgment sits at the one delivery step that already decides "post a copy to the operator's
topic" (the relay and the redirected topic-linked surface), rather than inside SalienceGate,
whose fallback semantics (first-only, fail toward quiet) other callers rely on. It reuses the
shared Jev cascade helpers (`bandFor`, `askReferee`) and the durable secret scrub.

## 4. Signal vs authority compliance

- [x] No block/allow surface on the message itself.

The verdict is a smart (LLM, by meaning) input to a delivery step; it holds no authority over
the peer, the session or delivery. The only deterministic rule is the protocol floor by wire
type, which never posts; every model failure resolves to posting.

## 4b. Judgment-point check (Judgment Within Floors standard)

New judgment point with floors: protocol types never posted (floor); budget → first-only
(floor); everything else judged by meaning with Jev-first cascade and a single-provider fallback.
No string matching of content.

## 5. Interactions

- Hub fallback: still runs whenever the relay does not post (including a held post being retried).
- TopicLinkageHandler: unchanged unless redirected; then the judge replaces SalienceGate for that
  reply and the per-thread minute is lifted; null from the judge (switch off / budget spent)
  hands back to SalienceGate.
- ack-stage wiring: the relay seam in routes.ts kept within the window
  `tests/unit/threadline/ack-stage-wiring.test.ts` pins (helper `wireTypeOf`).
- Spawn prompt: ownership is recorded synchronously at ingest, which precedes the router spawn on
  all three seams.
- Metrics: one more feature row on `/metrics/features`.

## 6. External surfaces

User-visible: later user-meant messages from paired agents now appear in their `🤝 <peer>` topic
with a notification. Egress: scrubbed message text goes to TypeSafe (Jev) when a key is
configured, and to the Codex or shared provider's vendor. Spawned-session prompt wording changes.
Nothing sent to peers changes.

## 6b. Operator-surface quality

No dashboard or approval surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, like §2.6: the machine that receives the message judges it and posts
through its own Telegram adapter. The daily cap, per-peer limit, retry queue and thread
ownership are per machine (in memory, cap seeded from that machine's log). Pool-wide spend is
therefore up to N × the cap for N receiving machines; in practice one machine holds the relay.

## 8. Rollback cost

Config: `threadline.peerHomebase.perMessageClassification: false` (live, no restart) restores
§2.6 exactly; `threadline.peerHomebase.enabled: false` turns homebase routing off. Code: revert;
no data migration; the audit log is append-only and unread by any decision path except the
daily-cap seed.

## Conclusion

Delivery-routing change with a live off switch, fail-toward-posting, and bounded spend.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur** (after two rounds that raised concerns; the reviewer re-checked the fixed tree).

Findings and resolution:
1. "Do not repost" prompt line could be false (brake held a post, send failed, wrong verdict, stale switch, sender evidence differing from the relay's) → the line is emitted only for a thread the relay actually took (ownership recorded synchronously at ingest from the transport's own evidence, switch on, budget available, conversation unbound); judged posts held by the brake or a failed send are retried (max 2, max 50 pending); wording softened; false-negative and stale-switch cases in the spec limits.
2. Budget exhaustion posted everything unjudged (a flood) → a spent budget returns `firstOnly` and the §2.6 rule with its brakes decides; ownership is not claimed under a spent budget and is dropped when a verdict comes back `firstOnly`.
3. Inject delay on redirected replies → budget cut to 6 s and stated in the spec.
4. Sender evidence mismatch between relay and router → solved by relay-recorded ownership (1).
5. Peer-asserted name could fake the prompt layout → one line, no control characters; the message is fenced for Jev.
6. Peer charged for decisions that ask no model; Jev call skipped the cap check → fixed.
7. Egress not stated → stated in spec, ELI16 and card.
8. A retry fired after the operator bound the conversation → retries re-resolve the destination and re-check the switch.
Non-blocking, accepted: on a new UTC day `budgetAvailable` re-reads the log tail until the first judgment; a non-operator binding made during a retry wait still resolves to the homebase (consistent with §2.6).

## Evidence pointers

- tests/unit/peer-user-meant-judge.test.ts
- tests/unit/peer-homebase-user-routing.test.ts (redirected judged replies)
- tests/unit/PostUpdateMigrator-peerHomebaseRefresh.test.ts
- tests/integration/threadline/peer-homebase-per-message.test.ts
- tests/e2e/threadline/peer-homebase-user-routing-alive.test.ts

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a`
- **reason** — one-shot reaction per inbound peer message: at most one model decision (≤3 calls, daily-capped) and one Telegram post plus at most two bounded retries; nothing re-triggers it.
