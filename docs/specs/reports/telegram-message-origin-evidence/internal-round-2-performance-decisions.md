# Round 2 — Performance and Decision Completeness

Reviewed the revised `docs/specs/telegram-message-origin.md` and its ELI16 companion. No runtime edits. Three remaining findings across the two perspectives.

## PERFORMANCE

First-round resolutions verified: logical-parent queueing and stampede exemption now preserve six-plus-child plans; child claims and fenced transitions are named; ambiguous in-flight claims cannot be automatically retried; the serving event loop is protected from synchronous contention; FULL/fsync durability is explicit; retained audit and temporary payload cleanup are separate; snapshot membership, per-shard progress, watermarks and unavailable coverage resolve the pool-pagination omission. These changes address the original findings in substance.

### P2-1 — DESIGN: prepared fallback copies must be inert until authority selection

The fallback paragraph permits switching sinks after an ambiguous preparation acknowledgement and says mirror copies never execute. Binding contract 5 nevertheless requires committing origin, plan and **executable outbox admission** atomically. Those instructions need an explicit state transition: a primary commit can succeed while its acknowledgement is lost, followed by acknowledged spool preparation. If the primary's committed row is already executable, a recovered worker can claim it while the spool worker also claims its copy. Local CAS on separate stores does not fence that race.

Recommended fix: the first transaction creates the origin, full plan and an **inert prepared admission**. Only a separate durable selection/activation record names the sole authority and makes children claimable there; every worker checks that activation before claiming. Selection/activation acknowledgement uncertainty holds the operation rather than selecting another sink. Redrive must preserve the same selection across submission retries. Mirror prepared rows remain permanently non-executable unless the selected authority can be reconciled through the specified protocol. Add a test where primary preparation commits and loses its acknowledgement, spool preparation succeeds, and both workers restart; exactly the selected authority may activate and execute. Keep claim ambiguity distinct from preparation ambiguity.

### P2-2 — PRECISION: define recovery budget accounting for child plans

Contract 11 now names six hours/nine attempts, but does not say whether nine applies per operation, per child, per episode, or whether successful initial child sends consume it. Contract 9's per-episode consult budget also leaves episode reset undefined. With up to 100 children, counting each child dispatch against a nine-attempt operation ceiling would reject a valid plan; resetting budgets per sink/episode can instead defeat the bound.

Recommended default: deadline is six hours after original parent preparation and never resets on restart, sink changes or transfer; nine recovery attempts per child, excluding its initial dispatch; accepted children never spend another attempt. Persist counters at the selected authority. A recovery episode is the single unresolved lifecycle of the original parent, so the one-consult cap cannot reset on every tick. State the maximum aggregate work (bounded child count times child retry budget) and retain the existing transport rate scheduler. Test ten children completing initially, one child's repeated known failures, and recovery through restart without budget reset.

## DECISION-COMPLETENESS

First-round resolutions verified: primary/spool/peer fallback now precedes refusal; captionless companions are explicitly display-dependent; retained searchable metadata and concrete hot-storage/capacity defaults are provided; ASP remains scoped to the existing operator-account requirement. These are presented as proposals rather than invented operator approvals. No cheap-to-change claims require contest.

### D2-1 — PRECISION: frontload the new browser-profile ownership change

The new browser paragraph introduces a substantive operational change: generic writable access to an agent's authenticated Telegram profile is removed and ownership moves to a broker. This is visible only in the technical design, not the Frontloaded Decisions list or ELI16 proposed choices. "Enroll or replace" also leaves an implementation-time decision about active browser work and login state. Browser/account migration is not cheap-to-change merely because activation is staged.

Recommended default: add a ninth frontloaded decision and one overview bullet explaining dedicated broker ownership, typed Telegram writes and preservation of the operator's separate personal browser. Reuse an already-authorized managed login when safely possible; do not replace an active profile or revoke a personal login. Complete inactive installation and validation first, then enroll at a verified idle boundary; if fresh interactive authentication is needed, explicitly report that external prerequisite and leave activation pending. This is a disclosure/migration default, not a reason to ask the operator to choose implementation details now.

## Disposition

One DESIGN finding (authority activation ambiguity), two PRECISION findings. The prior performance and decision findings are otherwise resolved. No additional user preference question is needed if the recommended defaults are incorporated into the concrete approval package; authentication, if actually required during deployment, remains an honest external prerequisite rather than a silently assumed capability.
