---
title: "Ephemeral Semantic Entity Expiry — every extracted entity is stored as a permanent fact; give the write path a way to say 'this is session-scoped state'"
slug: ephemeral-semantic-entity-expiry
author: "echo"
parent-principle: "Verify at the Consumer, Not the Producer (the proposal blamed a job prompt; the writer is code, and 99.4% of rows come from it)"
sibling-principles: "Structure > Willpower (an extraction schema that cannot express a TTL will never produce one, no matter what the prompt asks); Signal vs Authority (the extraction LLM DECLARES ephemerality, code CLAMPS the range — the model never picks a deletion date); Bounded Blast Radius (writing expires_at engages an existing DELETE path — the destructive half ships behind its own flag, after the read-side benefit is measured); Maturation Path — Every Feature Ships Enabled on Developer Agents; Testing Integrity"
eli16-overview: ephemeral-semantic-entity-expiry.eli16.md
source-proposal: "EVO-011 (approved 2026-08-23) — with its stated premise 'THE FIX NEEDS NO CODE' corrected here, see §1.2"
status: draft
review-convergence: pending
approved: false
depends-on: "ExtractedEntity shape (src/monitoring/SessionActivitySentinel.ts:63-68 — no TTL field, so the extraction LLM cannot express ephemerality); the extraction prompt's JSON schema + RULES block (src/monitoring/SessionActivitySentinel.ts:450-489); parseExtractedEntities (src/monitoring/SessionActivitySentinel.ts:532-554); materializeEntities remember() call (src/monitoring/SessionActivitySentinel.ts:385-395 — hardcodes confidence 0.7, passes no expiresAt); the findByName dedupe branch that reuses an existing row untouched (src/monitoring/SessionActivitySentinel.ts:383-386, SemanticMemory.findByName :1559); SemanticMemory.remember (src/memory/SemanticMemory.ts:1025-1085 — ALREADY accepts optional expiresAt at :1035, persists it at :1055); the hard-expiry DELETE branch in decayAll (src/memory/SemanticMemory.ts:1839-1874, expiry branch :1864-1873); the exporter's read-side expiry filter (src/memory/MemoryExporter.ts:125)"
---

# Ephemeral Semantic Entity Expiry

## 0. One-paragraph summary

Every entity in the semantic store is written with `expires_at = NULL`, so a
session-scoped observation ("the build is red", "holding PR 1966") is stored with
exactly the same permanence as a durable lesson, and reads back as current state at
every future session boot. The store's expiry machinery is not broken — it has simply
never been given a row to act on. This spec adds the missing lever at the **write**
side: an optional ephemerality signal on the extraction schema, clamped by code into a
bounded `expiresAt`, passed through the one `remember()` call that produces 99.4% of
the store. It ships in two stages, because writing `expires_at` engages an existing
**DELETE** path — stage 1 lands the entire user-visible benefit through the exporter's
read-side filter with zero destruction; stage 2 is a separate, later decision.

## 1. Problem

### 1.1 The measurement

Live against `.instar/semantic.db`, re-measured 2026-08-24 (proposal-time figures in
brackets, 2026-08-23):

| Column | Finding |
|---|---|
| `expires_at` | 1731 of 1731 rows NULL — **100.0%** [1568 of 1568] |
| `confidence` | 1715 of 1731 at exactly `0.7` — **99.1%** [98.9%] |
| `source` | 1720 of 1731 match `session:%` — **99.4%** written by code, not by an agent |

Two filters read those columns and both are inert by construction:

- `MemoryExporter.ts:125` — `if (e.expiresAt && …) return false` has excluded **zero**
  rows for the entire life of the store.
- `SemanticMemory.decayAll` (`:1864`) — the hard-expiry branch has deleted **zero** rows.

The confidence column is the same failure on the other axis and is deliberately **out of
scope here** — see §6.

### 1.2 Correcting the proposal's premise

EVO-011 states "THE FIX NEEDS NO CODE: `/semantic/remember` already accepts `expiresAt`.
The change is at the WRITE side — whatever extracts session observations must set
`expiresAt`." The first clause is true and the second is right about *where*, but the
inference is wrong: the extractor is not an agent reading a job prompt, it is
`SessionActivitySentinel.materializeEntities`. Its `remember()` call (`:385-395`) passes
a hardcoded `confidence: 0.7` and no `expiresAt`, and the `ExtractedEntity` interface it
materializes from (`:63-68`) has **no TTL field at all**. So the extraction LLM cannot
express ephemerality even if asked to, and a prompt-only change would have reached the
11 hand-authored rows (0.7%) while looking like a fix. This is the EVO-009 failure class
caught in advance: a producer-side plan validated at the consumer before it was built.

### 1.3 Why it matters twice

**Quality.** A present-tense state claim persists as permanent fact and is re-injected at
boot long after it went false. That is worse than absent memory — it is confidently wrong
memory.

**Capacity.** EVO-007 already measured the export budget as oversubscribed (7,154 words
against a 5,000-word budget, 83% of history excluded by the cap). Every stale-but-selected
entity displaces a durable one inside a window that has no room to spare.

## 2. What exists today

| Piece | Location | State |
|---|---|---|
| TTL on the extraction schema | `SessionActivitySentinel.ts:63-68` | **absent** |
| TTL in the prompt's JSON shape + RULES | `:450-489` | **absent** |
| TTL parsed from the LLM response | `parseExtractedEntities :532-554` | **absent** |
| TTL passed to storage | `materializeEntities :385-395` | **absent** |
| `expiresAt` accepted by storage | `SemanticMemory.remember :1035, :1055` | **present, unused** |
| Read-side expiry filter (export) | `MemoryExporter.ts:125` | **present, never fires** |
| Hard-expiry DELETE (decay pass) | `SemanticMemory.ts:1864-1873` | **present, never fires** |

The gap is exactly four small edits in one file, plus one guard flag in a second.

## 3. Design

### 3.1 The signal: the model declares, the code decides

Add one optional field to `ExtractedEntity`:

```ts
interface ExtractedEntity {
  type: EntityType;
  name: string;
  content: string;
  relationships: Array<{ to: string; relation: RelationType }>;
  /** Optional: the extractor's claim that this is session-scoped state, not a
   *  durable fact. A CLAIM, never a deletion date — the TTL is chosen by code. */
  ephemeral?: boolean;
}
```

`ephemeral: true` is a **claim about the kind of statement**, not a duration. The model
never names a date or an hour count. Code maps the claim to a TTL. This is the Signal vs
Authority split: an LLM that could write the expiry timestamp directly could also write
one an hour out, or ten years out, and a mis-parse would become a deletion schedule.

Prompt change — one line added to the JSON shape (`"ephemeral": false`) and one RULE:

> `ephemeral` is true ONLY for a present-tense statement about the state of something
> right now — a build being red, a PR being held, a session being blocked, a service
> being down. It is false for anything that stays true after the situation changes: a
> decision, a lesson, a person, a project, a tool, a durable fact. When unsure, use
> false.

The default is false, so absence, malformation, and model silence all land on today's
behavior. This is what makes the change purely additive.

### 3.2 The clamp

`parseExtractedEntities` reads `o.ephemeral` as a strict boolean (`=== true`); anything
else is false. `materializeEntities` maps it:

```ts
const expiresAt = e.ephemeral
  ? new Date(Date.now() + this.ephemeralTtlHours * 3600_000).toISOString()
  : undefined;   // undefined → remember() stores NULL, exactly as today
```

`ephemeralTtlHours` is config (`semanticMemory.ephemeralExtraction.ttlHours`), **default
48**, clamped in code to `[6, 720]` (6 hours to 30 days). The clamp is a code constant,
not a config bound: a config typo must not be able to schedule an instant deletion.

### 3.3 The dedupe branch (the subtle one)

`materializeEntities` calls `findByName` first (`:383`) and, on a hit, reuses the
existing id **without touching the row**. Two cases, decided:

- **Existing row already has `expires_at`, new observation is ephemeral** → refresh
  (extend to `now + ttl`). Re-observing live state means it is still live; letting it
  expire on the first sighting's clock would age out something currently true.
- **Existing row has `expires_at = NULL`** → **leave it NULL**, whatever the new
  observation claims. This is EVO-011's no-backfill guardrail enforced at the one place
  it could be violated by accident: a durable row must never acquire an expiry because a
  later, differently-shaped mention happened to reuse its name.

The reverse (an ephemeral row later re-observed as durable) also clears to NULL — a fact
promoted to permanence is the safe direction.

### 3.4 The destructive half, and why it waits

Writing `expires_at` is not inert: `decayAll` (`:1864-1873`) **DELETES** an expired row
and its edges. So the moment stage 1 writes a TTL, the next decay pass would destroy the
row — and a single mis-classification would be unrecoverable.

The whole user-visible benefit does not need that. `MemoryExporter.ts:125` already
filters expired rows out of the export **without deleting them**. So:

- **Stage 1 (this spec, ships first).** Write `expires_at`. Add
  `semanticMemory.ephemeralExtraction.hardDeleteExpired`, **default false**; when false,
  `decayAll`'s expiry branch skips deletion for rows whose `source` matches `session:%`
  (the auto-extracted population) and counts them into a new `expiredWithheld` field on
  `DecayReport`. Stale state stops reaching MEMORY.md; nothing is destroyed; the rows
  stay inspectable, so a mis-classification is a query away from being found.
- **Stage 2 (a separate, later decision, not approved by this spec).** After a soak
  with a measured mis-classification rate, flip `hardDeleteExpired` to reclaim the space.

Hand-authored rows (the 0.7% with a non-`session:` source) keep today's delete-on-expiry
behavior in both stages — an operator who sets an expiry explicitly means it.

### 3.5 Observability

`DecayReport` gains `expiredWithheld`. The digest path already reports entity counts;
add `ephemeralCount` to the per-digest log line so the classification rate is visible
from day one rather than reconstructed later. A stage-1 soak that cannot answer "what
share is being classified ephemeral, and were any of them durable?" has measured nothing.

## 4. Acceptance criteria

1. `ExtractedEntity` carries optional `ephemeral`; the prompt's JSON shape and RULES
   block describe it; `parseExtractedEntities` reads it as a strict boolean.
2. `materializeEntities` passes a clamped `expiresAt` for ephemeral entities and
   `undefined` otherwise. Confidence is untouched at `0.7` (§6).
3. The dedupe branch behaves per §3.3 — verified by test, both directions.
4. `decayAll` withholds deletion for `session:%`-sourced expired rows while
   `hardDeleteExpired` is false, and reports `expiredWithheld`.
5. **Consumer-side evidence (per EVO-009's standard), the test that this actually
   landed:** after one extraction cycle on a dev agent,
   `select count(*), sum(case when expires_at is null then 1 else 0 end) from entities`
   returns a **non-zero** non-NULL population, and spot-reading those rows shows
   state-shaped content. A result still at 100% NULL means the wrong path changed —
   the same trap that produced this spec.
6. MEMORY.md stops carrying resolved-state lines after the first export following an
   expiry.
7. Flags absent from config ⇒ byte-identical behavior to today.

## 5. Testing (three tiers)

- **Unit.** `parseExtractedEntities` on `ephemeral: true` / `false` / `"true"` / missing
  / null → only strict `true` classifies. TTL clamp at both bounds and past both bounds.
  Both dedupe directions (§3.3). `decayAll` withholding vs deleting, by source and flag.
- **Integration.** A digest carrying one ephemeral and one durable entity → the store
  holds one row with `expires_at` set and one NULL; the exporter includes both before the
  TTL and only the durable one after it, with no row deleted.
- **E2E / wiring integrity.** Boot the sentinel with a real `SemanticMemory` and assert
  the wiring is not a no-op: a state-shaped transcript produces at least one row whose
  `expires_at` is non-NULL. This is the tier whose absence is precisely why an all-NULL
  column survived the entire life of the store.

## 6. Deliberately out of scope

The hardcoded `confidence: 0.7` at `:388` sits in the same `remember()` call and is the
cause of the 99.1% constant-confidence column that collapses the exporter's rank onto its
`lastVerified` tie-breaker. It belongs to **EVO-005 / EVO-007**, whose MemoryExporter work
is still unlanded in `stash@{1}`. This spec does not touch it — but any implementer editing
`:385-395` is editing the same five lines, so read EVO-007 first and land them as one
conversation, not as two collisions.

Also out of scope: any bulk backfill of the existing 1731 rows. EVO-011's guardrail stands
— those are addressed by curation, never by a sweep.

## 7. Rollback

`semanticMemory.ephemeralExtraction.enabled: false` returns the write path to passing no
`expiresAt`; rows already stamped keep their TTL but are never hard-deleted while
`hardDeleteExpired` is false, so nothing is lost. Full revert is one commit — the change
is additive at every layer.

## 8. Decided defaults (not open questions)

| Question | Decision |
|---|---|
| Who names the duration? | Code. The model only claims a kind. |
| Default TTL | 48h, config-tunable, code-clamped to [6h, 30d] |
| Absent/malformed `ephemeral` | false — today's behavior |
| Durable row later seen as ephemeral | stays NULL (no retroactive expiry) |
| Ephemeral row later seen as durable | clears to NULL (safe direction) |
| Deletion on expiry | withheld for auto-extracted rows until a separate stage-2 decision |
| Existing 1731 rows | untouched |
