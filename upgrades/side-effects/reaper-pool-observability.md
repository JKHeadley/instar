# Side-Effects Review — Reaper pool observability

**Version / slug:** `reaper-pool-observability`
**Date:** `2026-08-02`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `required before ship`

## Summary of the change

The existing read-only SessionReaper snapshot, decision-audit, and reap-log
routes now honor explicit pool scope. The server reuses one shared full-roster,
non-recursive pool-read pattern: local evidence always answers, each peer
contributes validated machine-tagged evidence or a classified failure, and
bounded evidence reads expose per-machine returned/truncated state so the
newest-N window cannot look like complete history. Plain route shapes remain
unchanged. Integration and real-server lifecycle tests
cover successful peers, dark/old peers, malformed bodies, single-machine pool
scope, and plain-route compatibility. Documentation and scaffold instructions
teach agents to use the pool read for multi-machine diagnosis.

## Decision-point inventory

- Pool-scope branch on the reaper snapshot read — **add** — mechanical routing
  on an explicit query value; it cannot change session state.
- Pool-scope branch on the reaper audit read — **add** — mechanical routing on
  an explicit query value; it cannot change audit state.
- Pool-scope branch on the reap-log read — **add** — mechanical routing on an
  explicit query value; it cannot change shutoff history or session state.
- Peer failure classification — **add** — maps enumerable transport and shape
  outcomes to bounded diagnostic labels.
- Peer body structural validation — **add** — rejects malformed peer evidence
  from the success count; it does not block the local response.
- Evidence page metadata — **add** — an opt-in local page probe and mandatory
  peer page contract make every per-machine bound visible in pool responses.

---

## 1. Over-block

No user-action block/allow surface. A peer running an incompatible older route,
returning a non-object audit row, or returning a snapshot without the established
required fields is classified as failed instead of merged. That is intentional:
accepting it would recreate the exact ambiguity between “successful and empty”
and “could not supply trustworthy evidence.” The peer's own local route remains
available and the requesting machine still returns its local evidence.

An older evidence route that answers but omits requested page metadata is also
classified `invalid-body`. During a mixed-version rollout, unknown truncation
must fail visibly rather than be counted as a complete empty or complete bounded
source.

---

## 2. Under-block

A peer can return structurally valid but semantically nonsensical values within
the bounded accepted depth; this read tier verifies transport shape, not the
truth of another machine's measurements. Registry-owned machine identity and
remote/local attribution are always overwritten after parsing, so a peer cannot
impersonate another machine.
Each peer body is capped at 2 MiB and each evidence tail at 1,000 rows. The pool
response exposes `limitPerMachine` plus one `{ machineId, returned, truncated }`
source row per successful machine. Callers can therefore distinguish exactly-N
complete evidence from a truncated newest-N window; a ratio computed while any
source is truncated is explicitly window-scoped/incomplete. The aggregate still
grows with the registered pool size; Instar's bounded operator-owned machine
registry is the remaining scale boundary. Reap-log storage reads at most 2 MiB
per retained generation; whenever that byte window leaves an unread prefix,
`truncated` is conservatively true even if fewer than `limit` valid rows fit.
Corrupt/torn rows never consume the valid-row completeness probe.

---

## 3. Level-of-abstraction fit

The aggregation belongs in the HTTP read-composition layer, beside the existing
session, guard, attention, and subscription pool reads. The SessionReaper stays
machine-local and does not learn about peers. The helper reuses RouteContext's
registry and resolved-peer providers plus the established credential-address
validator; it does not create another registry, transport, or session authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The route exposes evidence and transport-health signals only. Its structural
validators implement hard API invariants; they do not judge user intent or gain
authority over keeping, reaping, restarting, or routing a session.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Query matching,
HTTP status classification, timeout detection, response bounds, and JSON shape
validation are enumerable protocol invariants. The existing SessionReaper's
session verdict logic is untouched.

---

## 5. Interactions

- **Shadowing:** the pool branch runs only for the exact explicit pool scope;
  ordinary reads return before fan-out and keep the old shape.
- **Double-fire:** peers receive plain routes, so aggregation cannot recurse or
  amplify across the mesh.
- **Races:** peer reads are concurrent snapshots and may describe slightly
  different instants, as other pool observability reads already do. No shared
  durable or session/lifecycle state is mutated, so there is no write race.
  The pre-existing local snapshot may prune its in-memory hourly-budget
  timestamps while reading. Audit and reap-log unions are globally sorted by
  timestamp with deterministic ties, keeping newest-last.
- **Adjacent pool reads:** the response uses the existing sessions/attention
  health envelope and guards-style per-machine snapshot list. It does not add a
  fourth pool convention. Evidence reads add a source ledger beside that health
  envelope because the per-machine tail bound is material to interpretation.
- **Credential safety:** a peer URL must pass the existing credential allowlist
  before the Bearer credential is attached.
- **Failure isolation:** a peer transport or validation failure becomes one
  sorted failure row and cannot turn the whole route into a 500.

---

## 6. External surfaces

This adds fields only when callers explicitly request pool scope. Plain route
shapes are test-pinned unchanged; an explicit `includePage=1` local read adds
only `{ page: { returned, truncated } }`. Other agents in the same operator-owned
pool receive authenticated read-only requests on their existing plain routes.
There are no Telegram/Slack notices, third-party calls, database changes,
persistent ledgers, new URLs, or operator mutations. Timing depends on peer
health but is bounded by a five-second per-peer timeout, streaming 2 MiB body
ceiling, nesting ceiling, and a shared six-per-minute pool-read limiter.

No operator-facing actions are added; the reads are diagnostics the agent can
perform conversationally.

Reap-log rows cross the machine boundary verbatim after structural validation,
including normally producer-clamped `workEvidence` strings. This is operational
detail about the same agent's own session/shutoff, not secret material or
another principal's data. The pool read adds no new audience: a holder of this
agent's Bearer credential could already query each machine's local reap-log.
This contract is explicitly same-agent, same-operator only. If cross-operator
federation is ever introduced, this disclosure assumption must be revisited.
Registry identity still overwrites peer-supplied identity, and all peer payload
remains untrusted, depth-bounded, and size-bounded.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read:** SessionReaper snapshots, decision audits, and reap-logs
remain machine-local truths; explicit pool scope fetches each registered
machine's plain local read and composes one honest response. Registry identity wins over
peer-supplied identity. A dark or old peer is represented by a classified
failure, while local evidence remains available. Evidence responses expose each
successful machine's returned/truncated state; an older peer that cannot supply
it fails visibly. Reap-log details cross only this same-agent, same-operator
authenticated boundary. The change emits no user-facing
notices, holds no new durable state that could strand on topic transfer, and
generates no URLs.

---

## 8. Rollback cost

Pure additive code, tests, and documentation. Revert and ship a patch. No data
migration, state repair, configuration reset, peer coordination, or user action
is required. During rollback, explicit pool scope would return to the prior
silent local-only behavior, which is why production verification should catch
the regression immediately.

---

## Conclusion

The review kept aggregation at the read tier, consolidated all three callers on
one helper and health envelope, and tightened address precedence, streaming
bounds, structural depth, authentication identity, registry attribution, and
timeline ordering so malformed evidence cannot count as a successful empty
result or crash the local answer. The added source ledger also prevents a
truncated newest-N denominator from being mistaken for complete evidence. The
routes are bounded, read-only, failure-isolating, and backwards compatible.
Independent second-pass rereview concurred after the corrupt-tail,
byte-window, and generation-gap fixes; the change is clear to ship subject to
the full release gates.

---

## Second-pass review (if required)

**Reviewer:** reaper_pool_review
**Independent read of the artifact:** concur. The final rereview independently
verified per-source completeness, corrupt/torn-row probing, byte-window
conservatism, no cross-generation gap, exact-limit completeness, mixed-version
failure visibility, and the B2 same-agent/same-operator disclosure.

---

## Evidence pointers

- `tests/integration/session-reaper-routes.test.ts`
- `tests/integration/reap-log-route.test.ts`
- `tests/e2e/session-reaper-lifecycle.test.ts`
- `tests/unit/reap-log.test.ts`
- `tests/unit/session-reaper-pressure-audit.test.ts`
- Focused integration + end-to-end run: 44 tests passed, including local and
  peer truncation, corrupt-tail and byte-window incompleteness, empty complete
  sources, mixed-version missing metadata, global chronology, and plain-response
  compatibility. Relevant storage-reader unit lanes add 27 passing tests.
- Measured pre-fix local baseline supplied by Echo: 9 genuine lease-related
  refused shutoffs in 500 reap-log rows (1.8%), all on 2026-07-20, zero since.
- The separately measured reaper-audit window contained 0 matching decisions in
  200 rows. This is a different evidence surface and window, not a contradiction
  of the 9/500 reap-log baseline.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no added or modified self-triggered
controller — not applicable. This change only adds read-only composition around
the existing reaper; its evaluation cadence and keep/reap authority are untouched.
