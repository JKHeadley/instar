# Side-Effects Review — WikiClaim Evidence Phase 5 (backfill CLI + render hardening)

**Version / slug:** `wikiclaim-evidence-phase5`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (idempotency + producer-narrowing-respected + cross-product privacy)

## Summary of the change

Ships the final WikiClaim phase per spec § Migration Plan line 347:

1. `instar memory backfill-evidence [--dry-run]` — one-shot, idempotent
   CLI that walks every existing `MemoryEntity`, pattern-matches the legacy
   `source: string` field, and synthesizes a single `MemoryEvidence` row
   of `kind: 'external-url'` when (and only when) the source string is an
   anchored `https?://…` URL. Any non-URL source string is left alone —
   `evidence: []` per spec § Risks line 357 ("no LLM in the migration path").
2. `src/memory/EvidenceRenderer.ts` — single privacy-enforcement helper
   exposing `renderEvidenceForScope(entity, viewerScope)`. Per spec
   § Storage and Privacy line 315 the renderer is THE enforcement boundary;
   this lands the helper now (before Phase 4 HTTP/dashboard rendering
   touches evidence in user-facing output) so every downstream consumer
   has exactly one place to filter from. `SemanticMemory`'s own read paths
   are switched to delegate to the helper for the entity-visible /
   evidence-visible predicates — keeping one source of truth.

### Phase 5 scope deliberately narrowed vs spec § Migration line 208–212

The spec lists four legacy-source patterns:

| Pattern | Backfilled to | Phase 5 status |
|---|---|---|
| `https?://…` | `kind: 'external-url'` | **shipped** |
| `session:ABC` | `kind: 'session'` | **skipped** |
| `user:Justin` | `kind: 'message'` | **skipped** |
| `observation` / any other | `evidence: []` | unchanged (no write) |

The narrowing is structural, not a deferral. Per spec § Producers line 229
and the Phase 1 `PRODUCER_KIND_ALLOWLIST`, the `manual` producer (the only
producer this CLI can invoke from outside any of the in-process subsystems)
is allowed to write `external-url` ONLY. The `session` and `message` kinds
require the `DecisionJournal` and `LearnSkill` producers respectively, which
have access to the originating subsystem's context (session metadata,
conversation transcript) that the CLI does not. **We deliberately do NOT
widen the allowlist to make migration easier** — that would unwind the
producer-kind capability boundary the spec installs.

A future bridge that walks legacy `session:` and `user:` sources from
inside DecisionJournal / LearnSkill (with full producer context) is a
clean follow-up and explicitly tracked in MEMORY.md.

What lands:

- `src/commands/memoryBackfillEvidence.ts` — pattern-match + dup-check +
  `addEvidence('manual')` call.
- `src/cli.ts` — register `memory backfill-evidence` subcommand with
  `--dry-run` flag and `-d <dir>`.
- `src/memory/EvidenceRenderer.ts` — `renderEvidenceForScope`,
  `filterEvidenceArrayForScope`, `isEntityVisibleAtScope`,
  `isEvidenceVisibleAtScope`. The latter two are imported by
  `SemanticMemory.ts` so the read-path predicates are no longer locally
  defined — they delegate to the renderer.
- `tests/unit/memory-backfill-evidence.test.ts` — 17 vitest cases:
  URL pattern match, non-URL skip, producer narrowing respected,
  idempotency across two runs, idempotency across entity privacy tiers,
  dry-run is non-mutating, apply-after-dry-run still writes, privacy
  inherits across every entity scope.
- `tests/unit/evidence-render-privacy.test.ts` — cross-product table:
  3 entity scopes × 5 evidence tiers × 3 viewer scopes (45 combinations)
  plus six edge-case assertions. Spec § Risks line 356 ("render every
  privacyScope × privacyTier combination and assert no leak") satisfied.
- `upgrades/side-effects/wikiclaim-evidence-phase5.md` (this file).

## Decision-point inventory

- URL anchoring (`^https?:\/\/\S+$`) — **add** — hard-invariant pattern
  match at the migration entry. Not judgment. Anchoring (no embedded URLs
  inside other text) keeps the migration deterministic across re-runs as
  the matcher evolves.
- Idempotency dup-check (`existing.some(ev.kind === 'external-url' &&
  (ev.path === source || ev.sourceId === source))`) — **add** —
  equality-based. Not judgment.
- Dup-check viewer-scope (`'private'` default, configurable) — **add** —
  reads the widest scope so the dup-check sees every existing row. A
  narrower default would silently allow a duplicate write against a
  private-tier evidence row on a shared-project entity. Tests pin this.
- Producer narrowing (`addEvidence(..., 'manual')` only) — **enforced**
  by `PRODUCER_KIND_ALLOWLIST`; the CLI inherits that gate, does not
  re-implement it.
- `privacyTier: undefined` on synthesized rows — **add** — per spec
  § Risks line 360, never auto-upgrade.
- `confidence: 0.5` on synthesized rows — **add** — matches spec
  § Migration line 210's suggested low-confidence value for coarse
  legacy provenance.
- `updatedAt: entity.createdAt` — **add** — preserves temporal ordering
  and means a second run on the same entity produces identical content.
- `EvidenceRenderer` helper — **add** — single-enforcement render path;
  no ad-hoc render exists today (Phase 4 HTTP/dashboard hasn't shipped)
  so this is preventive. `SemanticMemory`'s existing read-path
  predicates are switched to delegate to the helper so we have ONE
  visibility-comparison map across the codebase.

---

## 1. Over-block

**URL anchoring rejects embedded URLs:** `source: "see https://example.com"`
is skipped, not backfilled. By design — extracting a partial URL creates
ambiguity ("which one of the URLs in this string is the real source?")
and re-runs could backfill different URLs as the extractor evolves.
Producers that need to retroactively cite an embedded URL can run a
follow-up migration with a more permissive extractor; we keep the v1
backfill conservative.

**Whitespace not trimmed:** `source: "  https://x.com  "` is skipped.
Same reason — trim semantics depend on convention; v1 keeps the rule
"the source IS the URL, not a string containing a URL."

**Producer-narrowing rejects `session:` / `user:`:** Already covered
above. These need their own producer bridges, not this CLI. Explicitly
tracked.

## 2. Under-block

- **`external-url` is not URL-validated:** Beyond the `https?://\S+`
  anchor we don't parse the URL. A malformed-but-anchored value like
  `https://[invalid:` would be backfilled. The renderer treats
  `external-url.path` as display-only per spec § Threat Model line 372
  ("renderers MUST treat `path` for `external-url` as display-only —
  never auto-fetch"), so an invalid URL is a display-time annoyance,
  not an SSRF or injection vector.
- **`note` cap not retroactively applied:** We set a fixed
  `'Backfilled from legacy MemoryEntity.source (Phase 5 migration)'`
  note (52 bytes, well under the 500-byte cap). No risk.
- **Concurrency:** The CLI doesn't take a DB lock. If a producer is
  actively writing while backfill runs, both will succeed; the dup-check
  loses the race for entities that get a fresh `external-url` evidence
  row from a producer mid-scan. Mitigation: dup-check on every entity
  before write (already present); on race, the producer's row lands
  first and ours is skipped on second run. Operationally the CLI is
  intended for offline / quiet-period invocation; this is documented.

## 3. Level-of-abstraction fit

Right layer. The backfill belongs at the CLI / command layer because:
- It uses public `SemanticMemory` APIs (`export()`, `getEvidence()`,
  `addEvidence()`) — no private-state access.
- It's a one-shot operator-invoked migration, not a runtime path.
- Pattern matching is at the edge (the CLI), not inside storage.

`EvidenceRenderer` belongs in `src/memory/` because it owns evidence-shape
filtering logic; pulling it out of `SemanticMemory.ts` (without dragging
better-sqlite3 with it) lets non-SQLite render contexts (HTTP shapers,
dashboard JSON producers) use it without spurious dependencies.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change has no judgment-level block/allow surface.

The backfill's "skip" outcomes are mechanic-level pattern misses
(`URL_SOURCE_PATTERN.test(source) === false`) or idempotency dedupes
(equality-based dup-check). The renderer's filtering is mechanic-level
ordering comparison (`tier ordinal >= evidence tier ordinal`). No
intelligent gate, no judgment surface.

The actual semantic question — "should this entity be cited by an
external URL?" — was already answered by whoever set `source` on the
entity. The CLI replays that answer into typed evidence; it does not
re-decide.

## 5. Interactions

- **Phase 2 producers landing in parallel:** EvolutionManager /
  DispatchExecutor producers write `feedback`, `pattern-entity`,
  `job-run`, `ledger-entry`, `supersedes-evidence` rows. Backfill only
  writes `external-url`. Zero overlap; dup-check is keyed on
  `(kind === 'external-url' && path === source)` so even if Phase 2 had
  attached an `external-url` row via a different producer (none of them
  are allowed to per the allowlist), the URL-equality dup-check still
  catches it.
- **Phase 3 DecisionJournal / LearnSkill:** Same story — different
  kinds; non-overlapping dup-check keys.
- **`SemanticMemory.getEvidence` / `findCitations` / `getEntityWithEvidence`**:
  Now delegate to the `EvidenceRenderer.isEntityVisibleAtScope` and
  `isEvidenceVisibleAtScope` exports for the entity-visible /
  evidence-visible predicates. The Phase 1 in-file copies are removed.
  Verified by re-running the full Phase 1 test suite
  (`semantic-memory-evidence.test.ts` 21/21, `semantic-memory.test.ts`
  49/49, `semantic-memory-privacy.test.ts` 32/32) — all green.
- **JSONL append log:** Every `addEvidence` call in the backfill emits
  the existing `addEvidence` JSONL action; replay path is unchanged
  (Phase 1's deferred-handler note about JSONL replay still applies —
  unaffected by Phase 5).
- **No HTTP / dashboard / threadline render today:** Phase 4 hasn't
  landed; there is no ad-hoc evidence renderer in current production
  code to replace. The helper is preventive — landing it now means
  Phase 4 has exactly one place to call into when it adds HTTP routes
  and dashboard panels. **No ad-hoc paths were found and replaced.**
  This is documented as the intent rather than presented as completed
  retro-replacement work.

## 6. External surfaces

- **Other agents on the same machine**: None. Backfill is per-agent,
  per-state-directory.
- **Other users of the install base**: A new subcommand appears on
  `instar memory --help`. Default behavior of `instar memory <other>`
  is unchanged. Running the CLI is opt-in.
- **External systems**: None. Backfill is local-only; the
  `external-url` rows it writes store the URL as a string for display,
  never fetched (per spec § Threat Model line 372).
- **Persistent state**: One `addEvidence` JSONL row per backfilled
  entity, one `entity_evidence` table row per backfilled entity.
  Bounded by the number of entities with URL sources.
- **Privacy posture**: Tighter — backfilled rows inherit entity scope
  (`privacyTier: undefined`); never auto-upgrade. The renderer helper
  centralizes filtering; even if a Phase 4 callsite forgets to filter,
  the helper's existence + spec-mandated call pattern catches the bug
  at code-review time.

## 7. Rollback cost

- **Hot-fix release**: Pure additive change. `git revert <merge-commit>`
  ships as the next patch.
  - Backfilled `entity_evidence` rows from the `manual` producer would
    remain in the DB; they are well-formed and harmless (renderer hides
    them per viewer scope, never auto-fetched). If cleanup is desired,
    `DELETE FROM entity_evidence WHERE kind = 'external-url'
    AND note = 'Backfilled from legacy MemoryEntity.source (Phase 5 migration)'`
    is a precise rollback query.
  - `EvidenceRenderer.ts` deletion is fine; `SemanticMemory` would need
    to re-introduce the local predicates. The revert PR can re-add them.
- **Data migration**: None. Backfill is one-shot per entity by design;
  rollback doesn't undo the writes (they're treated as legitimate
  evidence rows), and re-running after revert+restore would just
  produce zero writes thanks to idempotency.
- **Agent state repair**: None.
- **User visibility**: Zero today (no HTTP / dashboard renderers Phase 4
  hasn't shipped); minimal after Phase 4 lands (filtered evidence rows
  appear next to entities).

---

## Conclusion

WikiClaim Phase 5 ships an idempotent, dry-run-safe, URL-only backfill
CLI plus the renderer helper that closes the privacy-enforcement loop the
spec § Storage and Privacy line 315 calls for. The CLI's intentional
narrowness (URLs only, never `session:` / `user:`) preserves the
`PRODUCER_KIND_ALLOWLIST` boundary Phase 1 installed; widening for
migration convenience would unwind a structural defense. The renderer
helper is preventive — Phase 4 HTTP/dashboard hasn't landed yet, so
there are zero ad-hoc renderers to replace today, but the helper is in
place and `SemanticMemory`'s own read paths now delegate to it so the
codebase has exactly one visibility-comparison map. Cleared to ship
pending second-pass concurrence.

---

## Second-pass review

_To be filled in by independent reviewer subagent._

---

## Evidence pointers

- New tests:
  `npx vitest run tests/unit/memory-backfill-evidence.test.ts tests/unit/evidence-render-privacy.test.ts`
  → 34/34 passing (~80ms).
- Regression:
  `npx vitest run tests/unit/semantic-memory-evidence.test.ts tests/unit/semantic-memory.test.ts tests/unit/semantic-memory-privacy.test.ts`
  → 102/102 passing.
- Typecheck: `npx tsc --noEmit` → clean.
- Cross-product privacy coverage:
  `tests/unit/evidence-render-privacy.test.ts` — 3 entity scopes × 5
  evidence tiers × 3 viewer scopes (45 combinations) + edge-case
  assertions.
- Spec source of truth:
  `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` §§ Migration
  of Existing MemoryEntity Records (line 202), Risks lines 357, 360,
  Migration Plan Phase 5 (line 347), Storage and Privacy line 315.
- Phase 1 artifact: `upgrades/side-effects/wikiclaim-evidence-phase1.md`.
