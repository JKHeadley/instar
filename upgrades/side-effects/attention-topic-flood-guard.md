# Side-Effects Review — Attention Topic-Flood Guard

**Spec:** `docs/specs/attention-topic-flood-guard.md` (converged, 4-reviewer panel)
**Change:** per-source + global forum-topic circuit breaker at
`TelegramAdapter.createAttentionItem` (the structural backstop). The redrive
offender fix shipped separately in PR #495 (merged); the redrive edits originally
bundled here were dropped to defer to it.
**Files:** `src/messaging/AttentionTopicGuard.ts` (new),
`src/messaging/TelegramAdapter.ts`, `src/core/PostUpdateMigrator.ts`, tests,
`tests/unit/feature-delivery-completeness.test.ts`, `upgrades/NEXT.md`.

## Phase 4 — the seven questions

1. **Over-block.** The guard never blocks an agent action or drops an item — it
   only changes *delivery form* (own topic vs. one coalesced topic + a log line)
   for **non-critical** items. The one legitimate behavior it changes: a
   non-critical source raising >3 items / 10 min has the surplus coalesced. That
   is the *intended* behavior (the operator asked for exactly this) and is tunable
   per adapter. HIGH/URGENT are never affected. No agent capability is rejected.

2. **Under-block.** Before the global ceiling was added, a source varying its
   `sourceContext` per item would have dodged the per-source budget — the review
   caught this; the global cap + key eviction now bound it regardless of source
   cardinality. Remaining under-block: a flood composed entirely of HIGH/URGENT
   items is not coalesced (by design — critical items must always be visible). A
   feature mis-marking routine noise as HIGH would still flood; that is a
   mis-classification bug in that feature, not in the guard, and is the correct
   place to fix it.

3. **Level-of-abstraction fit.** Correct layer: the breaker sits at the single
   chokepoint (`createAttentionItem`) where every attention item becomes a topic,
   so it covers all current and future callers. It is deliberately *below* the
   tone-gate authority on the `/attention` route (a transport-mechanics
   rate-counter, not a content-judgment filter). The per-feature redrive fix
   (PR #495) is at the feature layer; the guard is the substrate backstop — two
   layers, by intent.

4. **Signal vs authority.** Compliant. The guard holds no blocking authority over
   agent behavior or information flow; it is a delivery *shaper* (the rate-counter
   / transport-dedup carve-out in `docs/signal-vs-authority.md`), the same class as
   `SentinelNotifier`. It never withholds a critical notice and never drops an
   item.

5. **Interactions.** Audited against `SentinelNotifier` (separate path → the
   single reused system topic; no collision — it never flows through the guard) and
   the `agent-attention-topic` (not registered in the attention maps, untouched).
   Restart interaction (coalesced items vs. `loadAttentionItems` reverse-map
   corruption) and concurrency (double-create race) were both found by review and
   fixed. `updateAttentionStatus` no longer closes a shared topic when one
   coalesced sibling resolves (coalesced items aren't in the per-item maps).

6. **External surfaces.** User-visible change: a flooding source now produces one
   "🔁 …: notices coalesced (flood guard)" topic instead of a wall; the rest goes
   to `state/attention-suppressed.jsonl`. Fleet-wide via dist update, default-ON,
   no config. No new network calls; no new external dependency. The CLAUDE.md
   awareness section is backfilled to existing agents (idempotent migrator).

7. **Rollback cost.** Cheap. Single config flag:
   `messaging[].config.attentionTopicGuard.enabled = false` restores per-item-topic
   behavior. No data migration, no agent-state repair (the guard holds only
   in-memory counters). Worst case is a `src/` revert + patch release.

## Phase 5 — second-pass review (REQUIRED: touches a "guard" + outbound messaging)

An independent four-reviewer convergence panel (adversarial/security, integration,
architecture, scalability) audited the change against the diff. It raised 7
material concerns (global-cap dodge, `/ack`+shared-topic-close, case-sensitive
critical bypass, double-create race, hex plaintext to unverified address, NaN
config disable, unbounded audit log) plus framing notes. **6 of the 7 were fixed
in code this iteration; the 7th (hex plaintext) was a finding on the redrive edits
that are now deferred to the merged PR #495.** Full record:
`docs/specs/attention-topic-flood-guard.convergence.md`. **Concur with the review —
the design after this iteration addresses every raised concern; no blocking
authority on brittle logic remains.**
