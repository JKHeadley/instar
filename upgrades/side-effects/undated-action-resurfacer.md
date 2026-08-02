# Side-Effects Review — Undated Action Resurfacer

**Version / slug:** `undated-action-resurfacer`
**Date:** `2026-08-01`
**Author:** Instar-codey
**Driving spec:** `docs/specs/undated-action-resurfacer.md`
**Second-pass reviewer:** Codex independent reviewer
**Review posture:** reviewed against production wiring, failure paths,
bounded accumulation, signal-vs-authority, and self-action convergence

## Summary

Adds the action half of Close-the-Loop reach through a dedicated monitor, server
wiring, two authenticated evolution-action routes, a state-coherence registry
entry, and layered tests. The existing overdue checker keeps owning dated
actions. This component owns only pending, undated, high/critical actions
(including case-normalized historical spellings and legacy top-tier `urgent`)
and surfaces at most one Attention item per durable four-hour cadence. It never
mutates an action.

## Decision-point inventory

- eligibility — **invariant** — recorded status, due date, and priority only;
- selection — **invariant** — fixed 3:1 lanes, 30-day high-priority override,
  oldest creation time, then id;
- delivery — **invariant** — durable claim, stable id, emit, confirmation;
- terminal state — **invariant** — three unchanged raises require disposition;
- semantic disposition — **external authority** — a human or acting agent may
  work, cancel with reason, date, or split; the resurfacer cannot choose.

## 1. Over-block

The durable global cadence means a manual pass immediately after startup returns
without selecting another row. That is deliberate: a manual endpoint or restart
loop must not compress a four-hour scheduler into a flood. Pending rows with a
due date, lower priority, an active claim, a failed terminal claim, cooldown, or
needs-disposition state are excluded. A content, priority, or due-date edit resets
the raise series and restarts cooldown so active human engagement is not mistaken
for neglect.

At the 4 MiB ledger ceiling, the component refuses before appending. This pauses
reach until the ledger is reviewed rather than discarding actionable history.

## 2. Under-block

One item per four hours cannot drain the measured stock quickly, and the spec
states that explicitly. This is continuous reach, not backlog remediation.
Eventual surfacing depends on bounded eligible growth and a running scheduler.

The pre-live snapshot measured about 21.4 rows/day of creation-age density in the
newest seven days of the currently unresolved eligible cohort, against a
steady-state ceiling of two rows/day reaching the three-raise terminal, a 10.7×
ratio. This is not historical intake because resolved, dated, and reprioritized
rows are absent. It is recorded as open-pressure evidence, not reclassified as a
defect; live arrival and exit rates are required before choosing the next lever.

The 30-day high-to-critical override currently promotes no row: zero pending
actions are older than 30 days, while the 520 older stored rows are 515 cancelled
and 5 completed. The implementation keeps the future starvation brake and makes
no claim that it contributes to present-day throughput.

The pool-agreed stable-owner ledger trades availability for coherent cooldown
state. When the serving lease moves away from that owner, resurfacing pauses even though another
machine is serving. If any registered peer's latest authenticated advert omits
or disagrees on the owner proposal, it refuses visibly. A handback resumes the
original ledger; automatic state-owner migration is not claimed.

At storage capacity, the stable warning relies on the existing Attention dedupe
because the full ledger cannot safely persist a new warning marker. Repeated failed
deliveries can therefore be attempted again, but they keep one stable id and the
component remains stopped.

## 3. Level-of-abstraction fit

Selection and event folding live in a dedicated monitoring component. AgentServer
owns construction against the real action store, Attention destination, feature
metrics, and serving lease. Routes expose only status and one bounded pass. The
existing dated checker and action schema are unchanged.

## 4. Signal vs authority

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Decision-point answer:** yes. Eligibility, cadence, retry, capacity, and
ownership checks constrain whether the component may emit a signal. They are
enumerable transport and control-loop invariants, not judgments about what an
action means.

The component has deterministic delivery-policy authority: it decides whether and
when an eligible recorded row may produce an Attention item, including cadence,
retry, ownership, and capacity gates. Its emitted content is informational and it
has no semantic disposition authority: it never completes, cancels, reprioritizes,
dates, or splits an action. All selectors and brakes are deterministic invariants;
no model judgment is smuggled into the controller.

It therefore has no brittle semantic block authority. The only output is a
review signal delivered to Attention. Stable ids and duplicate suppression are
transport idempotency mechanics, an explicit exception in the governing
principle, while the owner/lease conjunction protects a single local ledger.

The recurring-notice self-heal rule does not apply as a first-detection repair
gate here: an undated action awaiting a disposition is not a recoverable machine
degradation, and choosing or performing its work is precisely the authority this
component is forbidden to assume. Its bounded handoff is the intended effect.

## 4b. Judgment-point check

No new static heuristic is placed at a competing-signals judgment point. The
fixed lane schedule orders rows inside an explicitly enumerated eligible set;
the stable-owner, lease, cooldown, retry, and byte-ceiling checks are mechanical
safety floors. None chooses whether the underlying action should be performed.

## 5. Interactions

- Dated actions remain exclusively owned by the overdue checker.
- Explicit creation-time follow-through opt-out remains eligible; it explains the
  missing date and does not grant permanent invisibility.
- The runtime boundary case-normalizes stored priority values and maps legacy
  `urgent` to the critical lane and URGENT Attention severity. Regression tests
  cover the exact live-store spellings that exposed the mismatch.
- Attention receives stable ids for ordinary raises, replay, aggregate disposition,
  and capacity refusal. Ordinary ids include a durable series generation so retry
  dedupes while a meaningful-edit reset cannot be suppressed by an earlier item.
- Feature metrics record fired, no-op, and error outcomes. The health read projects
  owner/lease blocking, last attempt/run, pool/cooldown counts, pending/failed/
  abandoned delivery claims, aggregate-alert claims, per-action raise/age state,
  and delayed outcomes by status from the append-only control ledger.
- The self-action registry declares this as an Eternal Sentinel with a durable
  four-hour rate floor and a three-raise per-target terminal.
- Initialization occurs after feature-metrics construction, and stop clears the
  cadence timer.
- Every confirmed delivery claim keeps its own delayed outcome schedule independent
  of the current projection, so completion, dating, or a meaningful-edit reset
  cannot erase the sample.

## 6. External surfaces

Two authenticated evolution-action service operations are added: the readable
health/status operation `GET /evolution/actions/undated-resurfacer` and the
one-pass trigger `POST /evolution/actions/undated-resurfacer/pass`. The only
user-visible live effect is an Attention item; default development rollout is
dry-run and fleet rollout is dark. No action content is sent to a new service,
and no new topic is created.

No operator-facing form, dashboard renderer, approval flow, or raw-input action
is added. The bounded pass is an authenticated agent-service operation and can be
invoked conversationally by the agent; it does not require the operator to use a
laptop or enter structured data.

## 6b. Operator-surface quality

No operator surface is changed, so the four operator-surface quality criteria
are not applicable. The user-visible artifact remains an ordinary Attention item
in plain language.

## 7. Multi-machine posture

Pool-agreed stable-owner machine-local. The ledger is bound to one configured
machine's local action-id namespace, but a local config value is only a proposal:
every registered pool member's latest authenticated heartbeat must advertise the
same owner. Missing or divergent adverts fail closed. The agreed owner may run
only while it also holds the serving lease. A handoff to a different machine pauses rather than
constructing fresh cooldown state; a handback resumes the original ledger. No
credential, URL, action mutation, or cooldown event is replicated by this feature.

It emits user-facing notices only while the stable ledger owner also holds the
serving lease, so it retains one voice. Durable state intentionally remains with
that owner and a lease handoff pauses the feature; no generated URLs exist.

### Bounded accumulation

The ledger is registered with a fixed 4 MiB ceiling and whole-file access below
the repository's 8 MiB synchronous-read limit. The writer refuses before the
ceiling, preserves old actionable evidence, exposes capacity health, and emits a
stable high-priority capacity signal. The integration growth burst asserts the
file stays within the configured test ceiling.

## 8. Rollback cost

Disable the feature or revert the construction, routes, component, registry row,
and tests. The ledger is additive local state ignored by older versions. No action
schema or action record requires migration or repair. Existing Attention items
remain ordinary resolvable queue entries.

Rollback is a normal hot-fix release: disable the feature immediately or revert
the runtime wiring in the next patch. The additive ledger needs no migration and
may remain on disk for a later re-enable; no action-store repair is required.

## Conclusion

The review changed the design materially before publication: lease-holder-only
state was replaced by a pool-agreed stable owner plus serving lease, reset series
received distinct Attention identities, every emitted claim retained its own
outcome schedule, aggregate failure now consumes its retry budget instead of
renewing forever, and capacity makes health non-operational rather than merely
setting a side flag. A later live-data review also found the typed/runtime
priority mismatch; case normalization and `urgent` compatibility now close it,
while the measured cadence gap and inactive age lane are recorded without
silently changing policy. The change is suitable for draft review while rollout
remains dry-run-first and fleet-dark.

## Second-pass review

The independent reviewer requested changes after finding three publication blockers:

- reset reused `resurface:{actionId}:1`, which the permanent Attention id store
  could suppress even though the ledger recorded a new series;
- the proposed stable owner was derived from potentially divergent local config,
  so two machines could each declare their empty local ledger canonical; and
- a meaningful edit reset the current projection and could erase the pending
  delayed outcome sample for an earlier confirmed delivery.

The implementation now assigns each reset a durable series generation, requires
unanimous latest owner adverts from all registered authenticated pool members,
and schedules outcomes per confirmed claim rather than per current projection.
The authority and live-evidence wording was also narrowed: this is delivery-policy authority
without action-disposition authority, and live transport evidence remains a
rollout gate rather than a draft-PR claim.

**Reviewer status:** **CONCUR.** The independent reviewer verified that all six
prior blockers are closed in code, tests, and claims. Its focused run passed 34
tests across the unit, real-Attention integration, authenticated peer-presence
integration, and production lifecycle tiers.

A follow-up review of the live-data delta initially withheld concurrence for two
reasons: the creation-age density of the currently unresolved cohort had been
overstated as historical intake, and representation-only priority changes were
normalized in code without a regression pinning series continuity. The claims
now name the snapshot and its survivor bias, rollout reserves actual arrival/exit
measurement, and the regression proves `urgent` → `CRITICAL` continues at
`s1:2`. **Follow-up reviewer status: CONCUR.**

## Evidence

- Focused unit, integration, lifecycle, development-gate, and self-action
  convergence suites are green; the exact command and counts belong in the PR
  verification record rather than a claim that can go stale in this artifact.
- Failure paths cover overlapping instances, restart cadence, transport replay,
  terminal retry without budget renewal, meaningful-edit reset through the real
  Attention dedupe store, divergent multi-machine owner proposals across handoff
  and handback, dated/completed retirement, per-claim delayed outcomes across
  reset, aggregate disposition, and storage refusal.

## Class-Closure Declaration

**Class:** `unbounded-self-action` · **Closure:** `guard` · **Enforcement:** ratchet
**Citation:** `tests/unit/self-action-convergence.test.ts`
**How caught:** under an indefinitely non-empty backlog, the ratchet reconstructs
the controller under sustained pressure and rejects any implementation that loses
the durable four-hour global rate floor or exceeds the three-raise per-target
brake; the live controller adds the same stable-owner/lease conjunction and a
fixed storage ceiling.

Registered as `undated-action-resurfacer`. Under indefinitely non-empty backlog
pressure, emission is an explicit Eternal Sentinel bounded by a durable four-hour
rate floor; reconstruction reads the same run ledger, per-row raises stop after
three unchanged passes, and the capacity ceiling stops storage growth loudly.
