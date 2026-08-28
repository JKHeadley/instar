# Side-Effects Review — Subscription sign-in reliability ledger

**Version / slug:** `subscription-signin-ledger`
**Date:** `2026-08-27`
**Author:** `Echo`
**Second-pass reviewer:** `not required — no messaging block/allow, session lifecycle, compaction, trust, sentinel, guard, gate, or watchdog surface`

## Summary of the change

This change adds a private SQLite sign-in evidence ledger, passive QuotaPoller instrumentation, a bounded authenticated history route, and a generation-and-witness authority for SubscriptionPool. It also wires lifecycle close, backup/file-view exclusions, fresh-install awareness, and an idempotent awareness migration for existing agents.

## Decision-point inventory

- Pool authority availability — **modified** — corrupt, unavailable, unconfigured, ready, and cleanup-pending are distinct typed states.
- Pool mutation commit — **modified** — a fully written candidate generation commits before rollback cleanup; cleanup-pending refuses later mutations without hiding the committed read state.
- Ledger admission — **added** — retain up to sixty-four supported, non-disabled account-and-machine cells, preserving incumbents.
- Authentication observation reduction — **added** — confirmed status transitions and provisional credential absence follow separate reducers.
- History read bounds — **added** — seven-day default, thirty-day maximum, and bounded returned rows.
- Account selection, sign-in, repair, and notification — **passed through unchanged** — the ledger owns none of these decisions.

## 1. Over-block

During `rollback-cleanup-pending`, legitimate pool mutations receive a typed conflict until restart completes cleanup. This is deliberate: replaying the mutation could apply it twice after the new generation already committed. Reads remain available. The sixty-fifth eligible account is unmeasured by this ledger, but remains in the subscription pool and remains usable; admission is an observability bound, not capacity authority.

## 2. Under-block

The v1 threat boundary assumes the trusted Instar process is the single application writer under the same operating-system user. It does not defend against a malicious concurrent same-user process racing filesystem operations. The local raw-history surface is implemented and bounded; signed cursor pagination, full pool-summary fan-out, and the independent refusal carrier are not claimed by this release increment and must not be presented as complete fleet analytics. The retained core still prevents credential absence from mutating account status.

## 3. Level-of-abstraction fit

The authority store owns durable pool-generation validity and crash recovery, which belongs below every pool consumer. QuotaPoller already owns the settled authentication-path outcome, so it emits passive observations there rather than adding another credential reader. The ledger is a signal store and reducer; SubscriptionPool remains account authority, and existing login/repair machinery remains action authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new login, repair, selection, or notification authority.

The only new block is deterministic authority-maintenance state after a possibly committed mutation. Credential absence and statistics are signals only and cannot gate work or mutate pool status.

## 4b. Judgment-point check

No competing-signals judgment is reduced to a static heuristic. The three-pass/thirty-minute credential-read floor is explicitly provisional evidence classification, not a decision to act. Pool validity and transaction recovery are enumerable invariants.

## 5. Interactions

- **Shadowing:** the literal history route is registered before the account-id route. Existing pool-scope reads keep compatibility with legacy lightweight pool implementations lacking v1 introspection methods.
- **Double-fire:** a settled quota-poll outcome is recorded passively; it does not duplicate status authority. Repeated status observations are idempotent because each cell permits one open episode.
- **Races:** SQLite writes run on one synchronous connection. Pool authority writes use a staged generation, witness, directory renames, fsyncs, and restart recovery. Cleanup-pending prevents unsafe replay.
- **Feedback loops:** ledger output is not fed into quota polling, selection, enrollment, or repair, so observation cannot cause the event it measures.

## 6. External surfaces

- Adds the authenticated `GET /subscription-pool/login-history` data route.
- Adds private machine-local files under `state/subscription-login-ledger` and the new subscription-pool authority directory. Backup and dashboard file-serving paths explicitly exclude both.
- Adds no external network calls, user notification, Telegram topic, sign-in action, or credential write.
- Existing agents receive conversational awareness through an idempotent CLAUDE.md migration; new agents receive it from the scaffold template.
- No operator-facing action is added. The route is read-only and can be used conversationally from a phone through the agent.

## 6b. Operator-surface quality

No dashboard renderer, approval page, grant form, or destructive operator action is added or touched. Not applicable.

## 7. Multi-machine posture

**machine-local BY DESIGN** for persisted evidence because credentials and their read failures are physical-machine facts. A future pool-scoped read must proxy summaries from each machine and name unavailable peers; it must never replicate credential evidence or silently treat an unreachable peer as healthy. This increment emits no user-facing notices and generates no URLs, so one-voice and link-transfer concerns do not apply.

## 8. Rollback cost

A hot-fix can revert the readers and passive writer. The new ledger files are private observational state and may remain ignored on disk; older code does not read them. Pool authority migration is reader-first: existing legacy authority remains the rollback representation in this release increment, so reverting does not strand accounts. No credential or user data repair is required.

## Conclusion

The review kept the feature passive, bounded, private, and honest about unavailable evidence. It also exposed one compatibility regression during the full suite: older pool-shaped route seams lacked `getAvailability`, causing async requests to hang. The read boundary now treats missing v1 introspection as legacy-readable, and the existing pool-scope regression suite pins that behavior. The core increment is suitable for deployment after the required independent review and complete green ship gate; advanced fleet analytics are explicitly not claimed here.

## Second-pass review

Not required by the instar-dev Phase 5 risk triggers. The change does not touch messaging block/allow, session lifecycle, context exhaustion, compaction, trust, a sentinel, a guard, a gate, or a watchdog. The pool transaction authority and passive reducer are instead covered by the converged two-spec review and executable crash/reducer tests.

## Evidence pointers

- `tests/unit/subscription-pool-authority.test.ts`
- `tests/unit/subscription-login-ledger.test.ts`
- `tests/unit/quota-poller.test.ts`
- `tests/integration/subscription-pool-routes.test.ts`
- `tests/e2e/subscription-login-history-lifecycle.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered action controller is added — not applicable.
