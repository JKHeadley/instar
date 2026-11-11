# Side-Effects Review — Context Budget Phase 1: S6, S7, S9, S10, S11, S17 landed together on S5

**Slug:** `cb-phase1-rest`
**Date:** 2026-11-11
**Author:** Echo (Opus 5.5)
**Second-pass reviewer:** each slice was reviewed and concurred individually by Fable 5.2 at build time; see the per-slice artifacts below.

## Summary of the change

This commit carries six Phase 1 slices of `docs/specs/context-budget-layered-summaries.md` onto PR #3072 (S5, the protected user corpus), so the rest of Phase 1 lands as one Local Verify run instead of seven serial runs with a rework round after each sibling merge (operator directive 2026-11-11: apply 80/20, no long tail blocking deployment). Every slice is unchanged in substance from its reviewed commit; the per-slice reviews still hold and are included:

| Slice | Reviewed commit | Side-effects artifact |
|---|---|---|
| S6 Anchor and decision ledger | 244005734 | `upgrades/side-effects/cb-anchor-ledger.md` |
| S7 Anchor and ledger backfill | 6fd8cd76b | `upgrades/side-effects/cb-backfill.md` |
| S9 H3 as single summary writer | cced5e5f9 | `upgrades/side-effects/cb-h3-writer.md` |
| S10 Standing packet and verifier | a44878764 | `upgrades/side-effects/cb-standing-packet.md` |
| S11 The 9.1 fix live (heal ladder, synthetic press, epoch) | 97e768578 | `upgrades/side-effects/cb-heal-ladder.md` |
| S17 Codex next-prompt seed + adapter suite | 8e77814a3 | `upgrades/side-effects/cb-codex-seed.md` |

## What the bundling itself changed (the only new decisions)

1. **`productionCanarySessions` (src/monitoring/contextBudgetSentinelBoot.ts)** — S11 and S16 (merged) each rewrote it. The merged function is the union: Claude Code sessions that are topic-bound *or* a valid synthetic-press target (S11's rule, unchanged), plus Codex topic-bound sessions read from their rollout when the Codex canary gate is on (S16's rule, unchanged, gate read live each tick). Codex throwaways are not press targets (the press targets Claude throwaways only), so no behaviour of either slice is widened.
2. **Canary wiring (src/commands/server.ts)** — the single `canaryInstance` (shared by the canary scan and S11's heal ladder) now carries S16's `engineInScope` gate; the scan receives both `pressChecks` (S11) and `codex` (S16).
3. **S17's hook template change** — main reads hook stdin into `HOOK_INPUT` once at the top of the telegram-topic-context hook; S17's second `HOOK_INPUT=$(cat)` before `USER_PROMPT` is dropped (a second read of stdin returns empty and would silently break Telegram topic routing).
4. **Test assertions that assumed a slice was alone** — Registry-First row tests (U, Anchor, backfill, H3) asserted "the line directly after row X"; with siblings sharing that anchor point they now assert the row sits inside the contiguous Context Budget block after X. The e2e capture-wiring assertion checks each spread's presence instead of the whole line. Each relaxed assertion was checked against a negative (it fails when the row/spread is missing).

## 1. Over-block
No new block/allow surface beyond the per-slice reviews.

## 2. Under-block
No new gap beyond the per-slice reviews. The union in (1) admits exactly what each slice admitted alone.

## 3. Level-of-abstraction fit
Unchanged per slice.

## 4. Signal vs authority compliance
Unchanged per slice; everything still ships dark behind `contextBudget.*` switches with feature-ladders entries.

## 5. Interactions
The one new interaction is (1)/(2): S11's heal ladder and S16's Codex canary share one canary instance. S16 marks Codex groups `counted` (never healed by injection), so the heal ladder never acts on a Codex group; S11's press never targets a Codex session.

## 6. External surfaces
Unchanged per slice.

## 7. Multi-machine posture
Unchanged per slice.

## 8. Rollback cost
Revert this one commit (or the squash-merge of #3072); every behaviour is dark by default, so a revert needs no data migration.

## Evidence
On the combined head: tsc clean; unit 254 files / 2,736 tests (the 2 sibling-adjacency assertions fixed, then all context-budget migration tests 16/16), integration 8 files, e2e 30 files / 91 tests, all green.

## Class-Closure Declaration (display-only mirror)

Class `unbounded-self-action`, closure `guard`: the self-triggered controllers this commit carries — S11's `context-budget-canary-heal` and `context-budget-synthetic-press`, S17's `context-budget-adapter-suite` (the Codex suite trigger), and S7's hard-bounded backfill lane — are registered in `src/testing/selfActionRegistry.ts` (or, for the backfill lane, bounded as stated in `cb-backfill.md`) and proven to settle by `tests/unit/self-action-convergence.test.ts` (ratchet). Bundling adds no new self-action.
