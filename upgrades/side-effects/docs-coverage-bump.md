# Side-effects review — docs-coverage second pass

Spec: `docs/specs/docs-coverage-bump.md`
ELI16: `docs/specs/docs-coverage-bump.eli16.md`
Companion to: the first round (`docs/specs/docs-coverage.md`) and the weekly audit (`docs/specs/docs-coverage-weekly.md`).

## Surface map

| Change | File(s) | Type |
|---|---|---|
| Floor ratchet | `scripts/docs-coverage.mjs` | Numeric edit to 7 default floors |
| New feature pages | `site/src/content/docs/features/{paste-handling,privacy-routing,remediator,task-flows}.md` | Pure docs |
| Route inventory | `site/src/content/docs/reference/api.md` (appended section) | Pure docs |
| Class inventory | `site/src/content/docs/architecture/under-the-hood.md` (appended section) | Pure docs |
| Sidebar additions | `site/astro.config.mjs` | Static-site nav config |
| Sidebar update for prior round | (same file) | Adds slack/observability/portability/coherence-gate/the-living-system/threadline-protocol that landed in v1.2.22 but weren't in the sidebar |

No production code touched. No agent behavior changes. No state migrations.

## Over-block analysis

**Could the floor ratchet block a legitimate PR?**

The new floors are set 3-8 percentage points below current measured coverage, which is the same buffer used in the first round. A PR that does normal feature work without doc updates would consume some of that buffer; a PR that adds many features without docs would consume more. The ratchet is calibrated to allow normal churn but require *some* doc work for new features. That's the intended behavior.

Escape hatches:
- Per-category env overrides for one-off PRs (`INSTAR_DOCS_COVERAGE_ROUTE_MIN=0` etc.)
- The bypass requires explicit env-var-setting, so it's visible in CI logs

**Could the route inventory misrepresent the API?**

The inventory is auto-generated from `src/server/routes.ts` by walking `router.<verb>(...)` registrations. Same regex the docs-coverage script uses. The inventory matches what the server actually registers; any drift would be a script bug affecting both the inventory and the gate.

The curated sections above the inventory still apply for non-obvious routes. Routes that need careful documentation (auth requirements, schema, error semantics) live in the curated section; routes whose path-and-method tell the story live in the inventory.

## Under-block analysis

The route inventory and class inventory provide *coverage*, not *understanding*. A reader pulling a class name out of the inventory still has to read the source file to know what the class does. This is a deliberate trade-off — the alternative is months of detailed prose for hundreds of items, most of which are internal.

The four new feature pages do provide understanding. They cover the highest-value gaps from the Pass 6 audit findings.

## Level-of-abstraction fit

The new feature pages live in `site/src/content/docs/features/` next to the others. Their depth is calibrated to user-facing concerns (how to use the system, when to choose it) rather than implementation details.

The inventories live in the appendix position of their respective pages — at the bottom, after the curated content. Readers who want detail get it from the curated content; readers who want navigation get it from the inventory.

The floor ratchet lives in the same numeric block as the original calibration, with the same env-var override pattern. No new config surface, just bigger numbers.

## Signal-vs-authority compliance

The floor ratchet is **authoritative** — it gates CI. The inventories are **signals** — they show what exists without claiming completeness of explanation. The four new feature pages are content, not signal/authority distinctions.

## Interactions with existing systems

- **Per-PR docs-coverage gate** — sees higher floors, behaves identically.
- **Weekly audit job** — observes the higher coverage, won't surface drift unless coverage *drops*.
- **CI workflow** — runs against the same script with the same arguments.
- **Astro Starlight site** — picks up the new sidebar entries on next deploy.

## Rollback cost

Trivially reversible. The script's threshold block is a single object literal; reverting is a one-line restore. The new feature pages can be deleted; the inventories can be removed (they're each delimited by a top-level horizontal rule).

## Risk summary

- **Low risk of regression.** Pure docs and one numeric edit.
- **Low risk of friction.** The new floors are below current state; normal PRs won't hit them. The escape hatch exists for the rare case where they would.
- **No risk of data loss.** No state mutation.

## Verification done before commit

- `node scripts/docs-coverage.mjs --check` passes with the new floors.
- Coverage report shows overall 62%, route 59%, class 62% — all above new floors.
- All four new feature pages render correctly in the local Astro build (verified — `npx astro build` produces 46 pages including the four new ones).
- Sidebar order verified.
- Spec carries `approved: true` per direct principal authorization in Telegram topic 11235.
