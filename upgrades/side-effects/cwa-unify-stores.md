# Side-effects review — unify the working-awareness stores (rung 2)

**Scope**: Give the working-awareness stores one ranked read path. Per the
ratified spec (`docs/specs/cwa-unify-stores.md`), this unifies the READ — extends
the existing `WorkingMemoryAssembler` to draw topic-intent refs + Playbook
manifest items into one ranked working-set section — NOT a physical store
migration. Additive, reversible, regression-pinned.

**Files touched**:
- `src/memory/WorkingSet.ts` — NEW. The `WorkingSetItem` lingua franca +
  `blendedScore`/`rankWorkingSet` (relevance × recency-decay) + two read-only,
  degrade-safe source adapters: `topicIntentToWorkingSet` (refs at/above tentative
  → items; relevance = confidence, recency = lastReinforcedAt) and
  `playbookManifestToWorkingSet` (scans `{stateDir}/playbook/**.json` manifests,
  trigger/tag-gated by the query, relevance = match + usefulness, recency =
  freshness — **never invokes the Python scripts**).
- `src/memory/WorkingMemoryAssembler.ts` — optional `topicIntentStore` + `stateDir`
  config; `workingSet` token budget (default 500); a new "Working Set" section
  appended AFTER the existing knowledge/episodes/relationships sections, gated on
  the new deps + content; `assembleWorkingSet`/`renderWorkingSet`; section header.
- `src/commands/server.ts` — pass `topicIntentStore` + `stateDir` to the assembler
  and broaden its construction gate to include `topicIntentStore` (so the unified
  read path is available even in minimal setups).

**Under-block**: None. The new section is purely additive context; it gates
nothing. Each new source is read-only and wrapped so an error/absence contributes
nothing.

**Over-block**: None. No authority anywhere — the assembler informs context, it
doesn't decide.

**Level-of-abstraction fit**: The stores keep their backends and write paths; only
the READ is unified, via the assembler that already does token-budgeted
multi-source assembly. The new sources speak the same `WorkingSetItem` shape and
flow through the same budget + render machinery. Playbook is read at the manifest
level (a stable JSON file), not through its Python CLI — the right seam for a fast,
degrade-safe assembler.

**Signal vs authority**: N/A — pure read/ranking.

**Interactions**:
- **REGRESSION PIN (load-bearing):** the working-set section is appended after the
  existing three and only when `topicIntentStore || stateDir` is configured AND a
  source returns content. With the new deps absent OR their sources empty, the
  assembled output is byte-for-byte unchanged — verified by (a) a dedicated unit
  test, (b) the existing 26 assembler unit tests + 9 working-memory route tests +
  the assembler-context route tests all still green, (c) a route test asserting a
  ref-less topic yields no working-set section.
- The assembler construction gate broadened to include `topicIntentStore` (always
  present), so the assembler now constructs in more setups. This is additive —
  callers in minimal setups gain a working-set context they didn't have; existing
  setups' output is unchanged (pin).
- The new section draws only from REMAINING token budget after the existing
  sources, so it cannot starve them.
- Playbook manifest scan is bounded (depth-limited, per-file try/catch) and
  trigger-gated (empty query → no Playbook items), so it can't flood or slow
  assembly.

**External surfaces**: New module `src/memory/WorkingSet.ts` (exports
`WorkingSetItem`, `blendedScore`, `rankWorkingSet`, the two adapters). New optional
assembler config fields + a `workingSet` budget. The assembled-context HTTP routes
now MAY include a "Working Set" section. No new endpoint, no config-shape change
for users (the assembler deps are wired server-side).

**Deferred (tracked)**: deeper cross-source blended re-ranking of the existing
sources (`cwa-physical-store-merge` rejected; cross-blend is implicit future work),
the Usher / mid-task re-surfacing (`cwa-usher`), capability+standards descriptors
as sources (`cwa-capability-index-context`). All in the spec's non-goals.

**Rollback cost**: Low. Drop the working-set section + the two adapter calls (or
just don't pass `topicIntentStore`/`stateDir`); the assembler returns to its
current three sources. No data migration. The regression pin guarantees the
revert is a no-op for existing output.

**Migration parity**: Additive assembler sources + budget default + the broadened
construction gate — all server-side (every agent gets it on update). No store
schema change, no hook/template/skill change, no user config change required.

**Convergence honesty**: Claude-authored + manual review; full multi-model
convergence tooling absent on host. This is the most architectural rung (touches
the shared assembler), so the regression pin is the primary safety and a fuller
multi-model review remains advisable — but the pin + the unchanged existing suites
bound the risk tightly.
