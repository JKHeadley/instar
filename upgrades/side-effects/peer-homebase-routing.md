# Side-Effects Review — route user-meant peer messages to the peer homebase

**Version / slug:** `peer-homebase-routing`
**Date:** `2026-10-31`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (changes message routing). Implements spec §2.6 (operator rule 2026-10-31: all messages
from an agent meant for the user show up in that agent's topic). New pure resolver
`resolvePeerUserTopic` / `makePeerUserTopicResolver` (`src/threadline/peerHomebase.ts`): operator
binding → homebase (mutual-verified peers only) → existing. New `PeerHomebaseRelay`
(`src/threadline/peerHomebaseRelay.ts`) posts a user-visible inbound message on an unbound
conversation into the homebase, invoked at the relay inbound funnel (`src/commands/server.ts`),
`/messages/relay-agent` (`src/server/routes.ts`) and the signed `/threadline/messages/receive`
route (`src/threadline/ThreadlineEndpoints.ts`); a message it does not post falls back to the
existing silent-hub surface. Peers are matched by fingerprint only, never by display name. `TopicLinkageHandler` gains an optional `resolveUserTopic` dep: the user-facing
"Reply from" post goes to the resolved topic, and when redirected a user-visible reply is posted
for every delivery mode (the session still receives the payload, which names the topic).
`ThreadlineRouter` spawn prompts carry a one-line topic hint. Both invite-pairing sides create
the homebase on the handshake's `finishing` / `finish-received` / `paired` notices. CLAUDE.md
awareness card updated with an in-place migration. Size: ~10 source files, ~450 LOC incl. tests.
Effort: one spec review round, one second-pass review (which raised a concern; fixes applied, see below).

## Decision-point inventory

- Where a user-meant peer message is posted — modify — new deterministic three-row destination rule (invariant: the operator's binding is the only thing that beats the homebase).
- Whether a peer message is user-visible — pass-through — existing `SalienceGate`, unchanged.
- Topic-linked surface condition (`shouldSurface`) — modify — adds "user-visible and redirected" as a surface case.

---

## 1. Over-block

No block/allow surface — nothing is refused, and every message still goes to its session. A
message the relay does not post (agent-internal, rate-limited, send failed) falls back to the
existing hub surface, which is deduped per thread (as before). The analogous risk is over-posting: a
redirected topic-linked thread now posts a user-visible reply to the homebase even when the
session in the originating topic will also relay it inline, so the user may see the reply in two
topics. Accepted: the operator's rule is that the peer topic must have it; the originating topic
copy is the session's own work. In production the SalienceGate has no classifier, so only a
thread's first reply is user-visible; posts are capped per thread (1/min) and per topic (3/min).

## 2. Under-block

- The operator rule says ALL user-meant messages. The server's own post is guaranteed only for what the SalienceGate marks user-visible; with no classifier (production) that is the first message of each thread. A later user-meant message reaches the homebase through the session, told the topic id in its prompt: prompt-level, not enforced. Stated plainly in spec §2.6 and the ELI16.
- A session's OWN later messages about a peer can still go to another topic despite the hint.
- A second user-visible message on one thread within a minute is rate-limited; it falls back to the silent hub rather than the homebase.
- The reap-recovery path (`ThreadlineReapRecovery`) does not call the relay; a message recovered there relies on the session hint.
- A conversation with a bound topic but no thread-resume entry posts nowhere new (pre-existing gap, unchanged).
- A peer whose homebase creation failed gets existing routing until a later message creates it.
- The in-memory "first message on this thread" set resets on restart, so the first message after a restart on an ongoing thread is posted again (bounded by the rate limits).

## 3. Level-of-abstraction fit

The destination is decided at the delivery points that already own Telegram posting
(TopicLinkageHandler, the inbound funnel), from one shared resolver, rather than by rewriting
bindings. It feeds on the existing SalienceGate instead of adding a classifier. Creation reuses
`PeerHomebaseBackfill.ensureFor` (same create-once / lease-holder discipline).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Routing only. Every failure path (resolver throws, store unreadable, send fails) falls back to
the existing destination or reports a reason; nothing is withheld from a session.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The destination rule is an
invariant stated by the operator (his binding wins, else the peer's topic); user-visibility stays
with the existing SalienceGate.

## 5. Interactions

- CollaborationSurfacer: for a peer WITH a homebase, the silent hub first-contact post is replaced by the homebase post when the relay posts (no double post), and still runs when the relay does not post. Peers without a homebase are unchanged. Loop-paused `notify()` housekeeping is unchanged.
- Identity: the resolver accepts a trust profile only when the lookup key equals the profile's own fingerprint, so a self-asserted display name cannot route into a paired peer's topic (second-pass finding 1).
- TopicLinkageHandler rate limits now key on the destination topic; the per-topic cap therefore spans every thread routed into one homebase, which is the intended anti-flood bound.
- Commitment delivery: a redirected `telegramSent` counts as surfaced-to-user, as before.
- Pairing: the notice listener calls `ensureFor`, which is idempotent and never throws, alongside the existing contact hook and boot pass; concurrent calls share one in-flight creation.
- The relay post goes through `withThreadlineForwardedAuthor` (inbound, forwarded-peer-author), the same origin attribution the topic-linked surface uses.

## 6. External surfaces

User-visible: messages from paired agents appear in their `🤝 <peer>` topic with a notification.
Nothing sent to peers changes. The spawned-session prompt gains one line. The existing
`threadline.peerHomebase.enabled` off switch (read live) restores prior routing.

## 6b. Operator-surface quality

No dashboard or approval surface touched — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the destination is decided on the machine that receives the message
(relay holder, or the topic owner for a cross-machine reply ask) from the replicated trust profile
and conversation record, and posted through that machine's Telegram adapter, like every other
post. Creation stays lease-holder-only. A standby that has not yet received a replicated homebase
id routes as before until it arrives (spec §6, CMT-014).

## 8. Rollback cost

Config: `threadline.peerHomebase.enabled: false` (live, no restart) — the resolver returns the
existing routing everywhere. Code: revert the PR; no data migration, no persisted state added
(the relay's per-thread memory is in-process). The CLAUDE.md card is refreshed in place and would
be refreshed again by a revert's card.

## Conclusion

Routing change with a live off switch and no new authority. Ready to ship after the second pass.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur** (after a first read that raised the concerns below; the reviewer re-checked all six against the fixed tree)

Findings and resolution:
1. Display-name spoofing into a peer's topic → fixed: fingerprint-only matching in the resolver; the server lookup is `getProfileByFingerprint` only; the local route uses the proven or registry fingerprint. Unit + integration tests added (a stranger's name never reaches a homebase).
2. Spawn hint claimed "the server has already posted it" (often false) → fixed: the hint now tells the session to post there itself; the signed `/threadline/messages/receive` path now calls the relay.
3. Hub fallback lost when the relay did not post → fixed: the hub surface runs whenever `posted` is false.
4. Spec implied every message is structural → fixed: §2.6 and the ELI16 now say plainly that only the first message (or what a classifier marks user-visible) is posted by the server, later ones by the instructed session.
5. Rate-limited message dropped from every topic → fixed by 3 (falls back to the hub).
6. Artifact optimistic → this section and §1, §2, §5 updated.
Remaining, by the reviewer's judgment optional and not a regression: on the signed `/threadline/messages/receive` path a message the relay does not post goes to no topic, as before this change (that path never had a hub surface).
The reviewer found no authority gained, the pairing listener correct, and the off switch restoring prior behaviour.

## Evidence pointers

- tests/unit/peer-homebase-user-routing.test.ts
- tests/unit/ThreadlineRouter-peer-user-topic.test.ts
- tests/integration/threadline/peer-homebase-user-routing.test.ts
- tests/e2e/threadline/peer-homebase-user-routing-alive.test.ts

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `n/a`
- **reason** — one-shot reaction to an inbound peer message: at most one Telegram post per message (per-thread 1/min, per-topic 3/min caps), plus a create-once homebase ensure on a pairing notice; no feedback path re-triggers it, so it is not a self-triggered loop.
