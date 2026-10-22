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
