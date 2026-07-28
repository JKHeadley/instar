# Side-Effects Review — Apprenticeship independence ladder registry

**Version / slug:** `apprenticeship-ladder-registry`  
**Date:** 2026-07-16  
**Author:** Instar-codey  
**Second-pass reviewer:** not required

## Summary of the change

Implements `docs/specs/apprenticeship-independence-ladder.md` §5.1: every apprenticeship instance stores `ladderRung` (R0–R5) and append-only `rungHistory`; the registry and authenticated route permit evidence-backed adjacent promotion or demotion. Legacy records with both fields absent migrate durably to R0, while partial or malformed ladder state fails closed. Capability discovery, docs, fresh scaffolding, and existing-agent migration carry the same contract.

## Decision-point inventory

- `ApprenticeshipProgram.transitionRung` — add — deterministic registry authority for an explicitly requested adjacent rung mutation.
- `POST /apprenticeship/instances/:id/rung-transition` — add — authenticated API boundary translating registry verdicts to HTTP status.
- `ApprenticeshipProgram.loadStore` — modify — structural validation distinguishes legacy absence from malformed persisted state.

## 1. Over-block

The registry intentionally refuses same-rung writes and multi-rung jumps even when evidence exists. A caller wanting R0→R2 must record R0→R1 and R1→R2 separately, preserving each decision. It also refuses a legacy row where only one new field exists; this is intentional because partial state has ambiguous provenance and cannot be safely reconstructed.

## 2. Under-block

The registry validates that evidence is present, bounded, and attributable as text; it does not judge whether a cited cycle or PR actually satisfies the rung criteria. The spec assigns that quality judgment to the overseer. The mechanism guarantees auditable evidence references, adjacency, and history integrity—not automatic graduation.

## 3. Level-of-abstraction fit

This belongs in the existing apprenticeship registry: it already owns per-instance durable state, optimistic persistence, and audit records. Route-level validation delegates the mutation decision to that single registry authority rather than reimplementing policy in HTTP handlers. No higher-level conversational gate is bypassed because the caller/overseer remains the graduation mind.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is hard-invariant validation over an enumerable state machine, one of the principle's explicit exceptions.

The blocking checks cover structural invariants only: integer R0–R5, adjacent transition, non-empty bounded evidence, coherent append-only history. They do not infer intent or evidence quality. The explicit overseer decision remains the context-rich authority; the registry makes that decision durable and refuses mechanically invalid representations.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. Whether evidence merits promotion is deliberately outside this method. The only static choices are enumerable storage/state-machine invariants defined by the approved spec.

## 5. Interactions

- **Shadowing:** rung transitions are independent of status lifecycle gates; neither runs before or suppresses the other.
- **Double-fire:** one request produces one CAS-backed instance update and one decision-log entry. Retry without recalculating the next adjacent rung becomes a same-rung refusal rather than a duplicate history append.
- **Races:** updates reuse the registry's optimistic-version persistence path, so concurrent writers cannot silently overwrite each other.
- **Cross-machine writes:** apprenticeship instance subroutes are classified `cluster-shared`, preserving a single-writer authority for rung and lifecycle history; the write-admission feature is still dry-run, so this classification changes no fleet behavior today.
- **Feedback loops:** no monitor, timer, or self-triggered controller consumes rung state in this arm.

## 6. External surfaces

The authenticated API adds one route and instance responses add two fields. Persistent `instances.json` state is normalized once for legacy rows. Other agents learn the route through fresh scaffolding and idempotent post-update migration. No Telegram, Slack, GitHub, Cloudflare, timing-dependent, or external-service behavior changes. No operator-only action is introduced: the agent remains the conversational interface and can execute the route for the operator.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard, approval page, grant/revoke form, secret form, or other operator-rendered surface is changed. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** apprenticeship instances are program state for the agent installation and use the existing instance registry's storage posture; this arm does not create a new cross-machine ownership or replication model. It emits no user-facing notices, generates no URLs, and does not actuate from topic ownership. Topic transfer therefore neither duplicates an action nor strands a pending notification. A pool-wide apprenticeship registry would require a separate approved replication design rather than silently inventing one inside this schema arm.

## 8. Rollback cost

A hot-fix can remove the route and transition method while leaving the additive fields ignored. Existing rung history should remain on disk as compatibility/evidence data; destructive reverse migration is unnecessary and undesirable. Legacy normalization writes cannot be undone automatically, but R0 plus explicit migration provenance is harmless to older code that ignores unknown fields. No agent reset or downtime is required.

## Conclusion

The review tightened load behavior so only complete absence qualifies for legacy migration; malformed or partial ladder state now fails closed. It also added current/fresh agent-awareness parity and strict final-history/current-rung coherence. The change is bounded to the approved registry arm and is clear to ship.

## Second-pass review (if required)

Not required: this change does not touch messaging, session lifecycle, dispatch, compaction, trust, sentinel/guard/watchdog behavior, or a judgment gate.

## Evidence pointers

- 78 focused unit, integration, migration, and E2E tests pass.
- `npx tsc --noEmit`, `npm run lint`, and `npm run build` pass.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
