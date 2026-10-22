# Side-effects review — binding provenance (homebase increment 1)

**Change:** `Conversation.boundTopicSource?: 'operator' | 'origin-inherited' | 'peer-homebase'`.
`ThreadResumeMap.applyEntryToConversation` tags an inherited origin topic `origin-inherited`
(without downgrading an existing `operator`/`peer-homebase` tag); `hubCommands` tags its
deliberate bind `operator`. Plus the converged + approved spec, its ELI16, and its report.

**Spec:** `docs/specs/peer-conversation-homebase-topic.md` (§2.2).

## 1. Over-block — what legitimate inputs does this reject?

Nothing is rejected. No gate, no refusal, no new authority. The change writes one additional
optional field; every existing read path is untouched.

## 2. Under-block — what does it still miss?

It records provenance from **now on**. Every pre-existing binding stays untagged, and the design
deliberately treats untagged as *preserve* rather than *overridable* — so the misdelivery this
spec exists to fix is NOT yet fixed for `pp`'s own conversation by this increment alone. That
needs the operator's explicit re-home (spec §2.2), which he has already requested. Stating it
because an increment that looks like the fix but is not is worse than one that is clearly a
foundation.

## 3. Level-of-abstraction fit

Right layer. The alternative — deleting the `boundTopicId = originTopicId` write — would have
changed a **shared merge path used by every conversation kind** to fix one of them, and other
resume paths read that field. Tagging the write leaves behaviour identical and moves the
decision to the routing layer, which is where "which topic should this message go to?" belongs.

## 4. Signal vs authority

**Signal only.** `boundTopicSource` is a provenance record. It blocks nothing, and nothing yet
reads it to make a decision — the routing consumer lands in the next increment. A field that
records how a value came to exist is the cheap deterministic input a later smart decision can
use; it holds no authority itself.

## 5. Interactions

- `applyEntryToConversation` is called on every resume merge. The added write is conditional on
  `entry.originTopicId !== undefined`, which already gated the existing write, so no new call
  path is touched.
- The non-downgrade guard matters: without it, a resume merge after an operator bind would
  relabel a deliberate choice as accidental, which is precisely the mislabel that would let a
  later increment move it. Tested in both directions.
- `hubCommands` already mutated the conversation; one more field in the same `mutate` call, so
  no new write or race.

## 6. External surfaces

No route, response, config key or user-visible string changes. The field appears in persisted
conversation records, which are machine-local JSON. No new egress.

## 7. Multi-machine posture (Cross-Machine Coherence)

**unified** — `boundTopicSource` is a field on the conversation record and replicates with it
under its existing class, exactly like `boundTopicId` beside it. No new locality, no new
replication path, nothing to strand on topic transfer. A peer that receives a record without the
field reads it as absent, which is the conservative *preserve* case.

## 8. Rollback cost

Near zero. The field is additive and optional; a read-time absent default is required and
present. Reverting the commit leaves records carrying a field nobody reads — harmless. No
migration, no data repair.

## Second pass

**Not required by the Phase 5 list:** no block/allow decision on messaging or dispatch, no
session lifecycle path, no compaction path, no coherence gate, idempotency check or trust level.
An additive provenance field with no consumer is the furthest thing from the shape Phase 5
polices. Recorded as `not-required` rather than omitted.

---

# Increment 2 — the homebase decisions (`src/threadline/peerHomebase.ts`)

**Change:** two pure functions and a selector — `homebaseTopicName`, `decideHomebaseBind`,
`selectConversationToBind`. No callsite yet; nothing invokes them in production.

1. **Over-block:** nothing is rejected — these are pure functions with no I/O and no gate. The
   relevant risk is the opposite (under-protection), covered below.
2. **Under-block:** `decideHomebaseBind` deliberately refuses to bind an `unknown-provenance`
   binding, so the feature will NOT fix `pp`'s conversation by itself. That is the correct
   trade (the alternative destroys deliberate operator choices) and it means the live case needs
   the operator's explicit re-home. `homebaseTopicName` reduces but does not eliminate name
   collisions — accepted in spec §6 and asserted as accepted in the tests.
3. **Abstraction fit:** the decisions are isolated from the wiring on purpose. Both are easy to
   get dangerously wrong in the permissive direction, and a pure function can be exhaustively
   tested in a way an inline branch at a callsite cannot.
4. **Signal vs authority:** pure advisory computation. They return a verdict; they perform no
   write, no send, no refusal. The caller holds whatever authority exists.
5. **Interactions:** none yet — no production caller. `BoundTopicSource` is re-declared here as
   a local type rather than imported from `ConversationStore`, so the helpers stay dependency-
   free and testable; the two must be kept in step, which the compiler enforces at the callsite.
6. **External surfaces:** none. No route, no config, no message, no egress.
7. **Multi-machine posture:** **not applicable — pure functions, no state.** The state they will
   operate on (the fingerprint→topic map) lands with the wiring increment and is specified
   `unified` in spec §7.
8. **Rollback:** delete the file and its test. Nothing imports it.

**Second pass:** not required — no decision point with authority, no messaging/dispatch gate, no
session lifecycle. Recorded as `not-required`.

**Honest status:** this is the decision layer only. Creating the topic, persisting the map, and
calling these from the trust-verify path are NOT in this commit.

---

# Increment 3 — the homebase record on the trust profile

**Change:** `AgentTrustProfile.homebaseTopicId?: number` plus `setHomebaseTopic` /
`getHomebaseTopic` on `AgentTrustManager`. Still no caller.

1. **Over-block:** `setHomebaseTopic` returns `false` rather than throwing for an unknown peer,
   a non-integer id, or an attempt to replace a DIFFERENT existing id. The last refusal is the
   point: a second write with a new topic would silently orphan the first, which is the
   duplicate-topic shape spec §6 accepts as a rare crash outcome but must never invite. The
   caller sees the refusal and can surface it.
2. **Under-block:** it does not verify the topic still exists in Telegram. A topic the operator
   deletes leaves a stale id, and routing would send to a dead topic. Accepted — that is the
   same class as §6's name-based identity, and the recovery is the operator re-creating or the
   next verification.
3. **Abstraction fit:** on the profile rather than in a new per-agent map, because the profile
   is already the durable per-peer record. A separate map would be a second place for one fact
   to be torn against the first, and it would need its own state-registry entry, retention
   declaration and replication story for no gain.
4. **Signal vs authority:** a record plus two accessors. No gate, no decision, no send.
5. **Interactions:** writes through the existing `save()` path used by every other profile
   mutation, so no new persistence mechanism and no new race. It touches `updatedAt`, which is
   correct (the profile did change) and is what every other mutator does.
6. **External surfaces:** none. The field appears in the persisted trust profile, which is
   machine-local.
7. **Multi-machine posture:** **unified** — it rides the trust profile, which already replicates
   under its existing class, so one homebase per peer agent-wide. That is the posture spec §7
   declares for the map, reached by putting it where replication already happens rather than
   adding a path.
8. **Rollback:** additive optional field; delete the accessors and the field. Records carrying
   an unread id are harmless. No migration.

**Second pass:** not required — no authority, no messaging/dispatch gate, no session lifecycle.

**Honest status:** the record exists and nothing writes to it in production yet. Creating the
topic and calling this from the verify path is the remaining increment.

---

# Increment 4 — wiring: the topic is created on mutual-verify

**Change:** `ensurePeerHomebase` in `peerHomebase.ts`, called from the pairing-confirm route
(`POST /threadline/pairing/:peerFp/verify`) downstream of `markMutualVerified`; the awareness
card (`peerHomebaseAwareness`) in both the template and the migration, each with its own guard.

1. **Over-block:** nothing is blocked. The call cannot fail a pairing: it is in a `try/catch`
   beside the existing best-effort receipt, and every internal failure path returns a reason
   instead of throwing. A peer with no homebase routes to existing behaviour.
2. **Under-block:** creation is only attempted when a pairing is CONFIRMED, so peers verified
   before this shipped get nothing until their next verify — the §6 no-backfill cut. A deleted
   topic leaves a stale recorded id, also §6.
3. **Abstraction fit:** at the route, downstream of the trust write, because the spec requires
   the trust single-writer to stay a single writer and an external side-effect must not sit
   inside it. The decision logic stays in the pure module; the route supplies the deps.
4. **Signal vs authority:** it creates and records; it gates nothing and refuses nothing. The
   one authority-shaped choice — `origin: 'user'` on the topic creation — is justified by the
   operator-ratified exception in spec §2.5 and is bounded by pairing being human-gated.
5. **Interactions:** sits beside the receipt send, which already establishes the
   "best-effort after confirmation" pattern, so the handler's success path is unchanged except
   for an added optional `homebaseTopicId` in the response. `findOrCreateForumTopic` is the
   funnelled primitive, so the universal topic-creation ceiling still applies.
   The handler became `async`, which Express already supports on this router.
6. **External surfaces:** **yes — this creates a Telegram topic**, the first increment with a
   user-visible effect. One per mutually-verified peer, holder-only, gated. The response gains
   an optional field. No new route.
7. **Multi-machine posture:** **machine-local creation by lease** · the record is **unified**
   (it rides the trust profile). A standby creates nothing — the 41-duplicate-"Updates" failure
   — enforced by `holdsLease: !ctx.state.readOnly`, the same signal the system-topic route uses.
8. **Rollback:** the gate. `threadline.peerHomebase.enabled: false` makes it a strict no-op
   (asserted by a test that the topic primitive is never touched when disabled). Reverting the
   commit removes the call. Topics already created are left alone — they may carry messages.

**Second pass:** this is the first increment with an external side-effect, so the Phase 5 list
is worth re-checking: it makes no block/allow decision on messaging or dispatch, touches no
session lifecycle, no compaction, no coherence gate, idempotency check or trust level. It
creates a topic. Recorded as `not-required`, but noted as the increment where that judgment
stopped being obvious.

**Migration parity:** the card is in `generateClaudeMd()` AND `migrateClaudeMd()` under its OWN
sniff string. It was first nested under the pool-read guard, which would have meant an agent
that already had that card could never receive this one — caught and fixed, and pinned by a test
that asserts the two guards are independent.

---

# Increment 5 — the integration tier, and the tier that is still missing

**Change:** `tests/integration/peer-homebase-create-and-record.test.ts` — `ensurePeerHomebase`
against a REAL `AgentTrustManager` (file-backed, real persistence) with the Telegram primitive
faked at its boundary.

What it adds over the unit tier, which used injected deps for everything: the recorded id
actually survives a reload from disk; a second pass makes **no external call at all** rather
than merely returning a no-op verdict; and the gate and the lease check both stop execution
BEFORE the topic primitive is reached, asserted by observing that the fake was never called
rather than by trusting the return value.

**The tier that is NOT covered, stated plainly.** Testing Integrity asks for all three tiers,
and the Tier-3 "feature is alive through the HTTP pipeline" test does not exist for this
feature. Driving `POST /threadline/pairing/:peerFp/verify` requires reproducing the pairing
handshake — two in-process identities deriving a real SAS — which the existing
`tests/e2e/threadline-verified-pairing-alive.test.ts` harness does and which I did not
replicate inside the remaining time. What I did instead: ran that existing e2e against the
modified route and confirmed it still passes 8/8, so the route is not broken, but nothing yet
asserts that a homebase topic appears when a real pairing completes through the real server.

That is a genuine gap, not a technicality, and it is the single most valuable test still owed
for this feature. Recorded here rather than left for someone to discover from the absence.

1. **Over/under-block:** a test file; blocks nothing. The under-coverage is named above.
2. **Abstraction fit / signal vs authority / interactions / external surfaces:** none — no
   production code changed in this increment.
3. **Multi-machine posture:** not applicable (test-only).
4. **Rollback:** delete the file.

---

## Increment 5 (post-merge CI fix): register the card in the parity list and the shadow

**What changed.** Two one-line registrations: `'per-peer homebase topic'` added to
`featureSections` in `tests/unit/feature-delivery-completeness.test.ts`, and
`'### Where a peer agent\'s notices go (per-peer homebase topic)'` added to the
`migrateFrameworkShadowCapabilities` `markers[]` array in `src/core/PostUpdateMigrator.ts`.
No behaviour, no route, no state, no config.

**Why, and why it is not cosmetic.** CI failed consistently on shard 4/4 of BOTH node
versions with "PostUpdateMigrator adds CLAUDE.md section 'per-peer homebase topic' but it's
not tracked". The awareness card had reached `generateClaudeMd` and `migrateClaudeMd` but
neither the parity list nor the shadow markers, so **a Codex or Gemini agent would never have
received it.** For this card specifically that is the whole feature failing: its purpose is to
stop an agent reporting "I passed it on" while posting where the operator has no reason to
look, which is the founding incident. A non-Claude agent would have kept doing exactly that
with the fix installed — the Agent Awareness Standard's own stated failure mode.

**The two string forms are load-bearing and deliberately different.**
- The parity list carries the BARE sniff string, because `all new migrator CLAUDE.md sections
  are tracked` compares `featureSections.includes(section)` **exactly** against what
  `migrateClaudeMd` content-sniffs.
- The marker carries the FULL heading, because `markers[]` entries are **slice anchors**:
  `claudeMd.indexOf(marker)` then skips past the marker's own line, so a mid-heading anchor
  would mirror the body into AGENTS.md/GEMINI.md **without its heading**. The apostrophe in
  "agent's" is escaped; a first attempt with an unescaped one would not have compiled.
- The shadow-parity guard (`shadowMarkersBlock.includes(section)`) is satisfied because the
  bare sniff is a substring of the full heading — so the two forms stay consistent by
  construction rather than by someone keeping them in step.

1. **Over/under-block:** blocks nothing. It makes two existing guards see a card they were
   blind to. The risk it REMOVES is a silent awareness gap on non-Claude frameworks.
2. **Abstraction fit / signal vs authority:** no authority added. A shadow marker copies
   documentation into a sibling file; it grants nothing.
3. **Interactions / external surfaces:** none. No network, no credential, no Telegram, no
   filesystem outside the two source files.
4. **Multi-machine posture:** none — this is install-time documentation parity, identical on
   every machine.
5. **Migration Parity:** this change IS the Migration-Parity repair. Existing Claude agents
   already receive the card via the pre-existing `migrateClaudeMd` branch (unchanged);
   existing Codex/Gemini agents now receive it too, on their next migration run.
6. **Rollback:** revert the two lines. CI returns to red on shard 4/4, which is the honest
   signal that the gap is back.

**Evidence.** `tests/unit/feature-delivery-completeness.test.ts` 212/212 (was 211/212 with
this exact assertion failing); 175/175 across the four `peer-homebase-*` files plus
`PostUpdateMigrator-shadowCapabilities.test.ts`; `tsc --noEmit` clean.
