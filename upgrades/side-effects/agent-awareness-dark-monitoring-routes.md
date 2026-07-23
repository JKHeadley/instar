# Side-Effects Review — dark monitoring-route agent awareness

**Version / slug:** `agent-awareness-dark-monitoring-routes`
**Date:** `2026-07-23`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `capability_honesty` (independent Codex review)

## Summary of the change

Adds shared CLAUDE.md awareness sections for the already-existing
`GET /pool/failover-gap` and `GET /pool/missing-login` status routes. Fresh
agents receive the sections from `generateClaudeMd`; existing agents receive
them through content-sniffed, additive, idempotent migration. The two existing
CapabilityIndex entries are intentionally unchanged.

## Decision-point inventory

- `migrateClaudeMd` heading checks — add — deterministic presence checks decide
  whether to append documentation. They do not inspect runtime health or decide
  any monitoring outcome.
- Runtime guard decisions and Attention emission — pass-through — unchanged.

## 1. Over-block

No block/allow surface is added or changed. The migration only appends missing
documentation.

## 2. Under-block

The awareness text cannot make a dark guard live and cannot repair either
condition. It explicitly says a 503 is unknown posture, not a healthy verdict,
and that dry-run sends no Attention item.

## 3. Level-of-abstraction fit

One shared source generates both fresh-install and migration text, preventing
documentation drift. Each route retains its own heading and content sniff, so a
partially upgraded agent receives only the genuinely missing section.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

Both runtime features remain signal-only. The new text describes status and
proactive read triggers; it grants no recovery, credential, session, or
notification authority.

## 4b. Judgment-point check

No competing-signal or semantic judgment point is added. Heading presence is
an enumerable migration invariant.

## 5. Interactions

- **Shadowing:** each distinct heading is checked independently.
- **Double-fire:** a second migration is byte-identical and records no second
  upgrade.
- **Races:** migration uses the existing single-file migration path.
- **Feedback loops:** reading either status route changes no state.

## 6. External surfaces

No API, configuration, persistence, notification, or UI surface changes. The
existing routes and registry entries are only documented to agents.

## 6b. Operator-surface quality

No new operator UI. The agent-facing prose leads with posture, uses plain
language, distinguishes 503 from health, and names when to consult each route.

## 7. Multi-machine posture

The failover route observes peer availability; the missing-login route observes
machine-local login/session correlation. This change does not alter either
scope. It tells agents to report the observed route posture rather than
guessing across machines.

## 8. Rollback cost

Revert and ship a patch. Previously appended awareness prose remains harmless;
no state or runtime repair is required.

## Conclusion

The change closes only the awareness and migration-parity gap. Runtime guards,
dark gates, dry-run posture, CapabilityIndex ownership, and all authority remain
unchanged.

## Second-pass review

**Independent read:** concur after two documentation corrections.

The reviewer verified the exact runtime posture, route predicates, action
boundaries, independent content sniffs, second-run byte idempotency, and the
decision to leave both existing CapabilityIndex entries untouched. The review
caught wording that called the guards “development-only”; this was narrowed to
“dev-gated and fleet-dark by default” because an explicit operator
`enabled:true` remains supported. The upgrade message was also narrowed from
claiming Instar can always answer to saying agents know where to check when the
route is available.

## Evidence pointers

- `tests/unit/PostUpdateMigrator-darkMonitoringRoutes.test.ts`
- `tests/unit/feature-delivery-completeness.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect or self-triggered controller is added.
