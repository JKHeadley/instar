# Side-Effects Review — Correction promotion clustering and session diversity

**Version / slug:** `correction-promotion-clustering`
**Date:** 2026-07-30
**Author:** Instar-codey
**Second-pass reviewer:** independent CMT-1133 review — final approved

## Summary of the change

`CorrectionAnalyzer` now groups similar open corrections at analysis time, only
within the same `kind`, and evaluates recurrence over the cluster's exact keys.
The stored `dedupeKey` algorithm is unchanged. The preference recurrence gate
keeps support and day durability but replaces topic diversity with session
diversity. `CorrectionLedger` adds nullable occurrence-level `session_id` via an
idempotent in-place migration so exact-key repeats across sessions remain
countable. A route first transitions all supporting records atomically into one
durable `route_cluster_id` and verify window, then invokes its external effect.
Verification observes recurrence across every durable member key.

## Decision-point inventory

- `CorrectionAnalyzer.clusterCorrectionRecords` — add — similarity detector that produces same-kind evidence groups.
- `CorrectionAnalyzer.analyze` — modify — deterministic recurrence authority consumes cluster evidence and the session-diversity prong.
- `CorrectionLoopDriver.route` — modify — one crossed cluster produces one route; supporting records transition atomically before the external effect.
- `CorrectionLoopDriver.runVerification` — modify — recurrence and lifecycle outcomes are cluster-scoped.
- `CorrectionLedger.updateCluster` — add — all-or-none optimistic-concurrency transition for durable cluster lifecycle.
- `CorrectionLedger.distinctCounts` — modify — aggregates evidence across exact keys and reports sessions.

---

## 1. Over-block

This change does not block messages or operator actions. The relevant false
negative is under-grouping: a genuine paraphrase below 0.65 remains a singleton.
The live corpus demonstrates loose approval-link variants in that state. That
is deliberate because a missed promotion is safer than asserting a preference
the operator did not express.

---

## 2. Under-block

The grouping rule is complete-link first-fit: every pair in an admitted cluster
must clear 0.65. This removes the single-link bridge risk found in independent
review (the old 9-row component had 20/36 pairs below the floor and a 0.3846
minimum). A larger labeled corpus may justify changing the threshold or grouping
method; one 37-row corpus cannot establish a universal semantic boundary.

Historical occurrence rows have no occurrence-level session provenance. They
fall back to the owning record's session id; if that is absent they do not count.
This can undercount old cross-session exact repeats, never manufacture support.

---

## 3. Level-of-abstraction fit

Grouping belongs in `CorrectionAnalyzer`: it already holds the full open-record
set and grouping changes promotion evidence without rewriting stored identity.
`CorrectionLedger` remains the exact-key store and only supplies union counts.
The driver remains the sole mutation layer. This avoids a taxonomy in the
distiller and avoids semantic judgment on the write path.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — similarity is a detector consumed by the existing recurrence and routing authority.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Jaccard does not independently route or write. It supplies a candidate evidence
group to the pre-existing deterministic recurrence policy, which still requires
four qualifying occurrences, multiple days, and (for preferences) multiple
sessions. The driver retains its by-construction limited capabilities and
policy-relaxation disposition path.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The new heuristic compares one signal (normalized text overlap); it is not a
competing-signals choice among liveness, ownership, urgency, or work evidence.
It operates inside explicit floors: same kind, Jaccard 0.65, deterministic
provenance, support, days, and sessions. It cannot bypass any floor.

---

## 5. Interactions

- **Shadowing:** exact ledger dedupe still happens first. Analyzer grouping only
  joins distinct exact keys later and does not shadow ledger identity.
- **Double-fire:** one verdict is emitted per cluster. After a successful route,
  every supporting record leaves `open`, so a remainder cannot route the same
  family next tick. A unit test runs the driver twice and pins one route total.
- **Races:** every member's version is preflighted and changed in one SQLite
  transaction **before** the external effect. A stale member aborts the entire
  cluster, audits `cluster-transition-conflict`, and invokes no effect. This is
  at-most-once: an ambiguous effect failure leaves the durable reservation in
  `acted-on` rather than retrying and duplicating an external item.
- **Feedback loops:** routed records preserve exact keys plus a durable shared
  cluster id. Recurrence on any member key reopens the whole cluster, and the
  cluster verification transition is also all-or-none. Reopened clusters stay
  watchable with a reset window start, so an old occurrence cannot burn through
  `maxReopens`; tests pin both a clean second window and a genuinely new second
  recurrence. No new capture or self-violation event is generated by grouping.

---

## 6. External surfaces

Existing agents receive two additive nullable SQLite columns and indexes on the
next ledger open: occurrence `session_id` and record `route_cluster_id`. No key,
record id, preference file, or correction API text is rewritten. Configuration
uses `minDistinctSessionsPreference`; add-missing default merging supplies it to
existing agents while the old topic key, if present, becomes inert.

The analyzer job stays disabled. The live corpus was opened read-only; no live
preference or job state changed. When an operator later enables the existing
feature, qualifying families can route where previously every paraphrase was a
singleton.

No new operator-facing action, external API, URL, or message format is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** The correction ledger is already listed in the state coherence
registry and travels through the existing agent-state replication path. This
change preserves that store and adds evidence fields inside it. Analyzer
behavior is deterministic on each replica.

It emits no new notice, so no new one-voice gate is needed. It creates no new
durable store and no URL. Existing preference writes retain their existing
replication and topic-transfer posture.

---

## 8. Rollback cost

- **Hot-fix release:** revert analyzer, config, and driver behavior.
- **Data migration:** nullable `session_id` / `route_cluster_id` columns and
  indexes may remain; old code ignores additive SQLite fields. No destructive
  down-migration is needed.
- **Agent state repair:** none, because dedupe keys and existing rows are unchanged.
- **User visibility:** rollback restores exact-key/topic-gated behavior, which
  returns the loop to under-promotion but does not corrupt learned preferences.

---

## CI follow-up review

The full matrix found two completeness gaps in the original shipping set, not a
new production decision. The end-to-end acceptance fixture still varied topics
but omitted occurrence-level sessions; it now proves the required gate with two
days and two sessions while deliberately staying in one topic. The new
`updateCluster` storage-error boundary already reports through the ledger's
injected `onError` callback and returns a typed fail-closed result; an inline
`@silent-fallback-ok` explanation now makes that non-silent behavior visible to
the repository scanner. Shutdown cleanup has the same explicit idempotent
justification. No ratchet baseline changed.

This follow-up does not alter clustering, routing, verification authority,
persistent schema, multi-machine posture, or rollback cost. It strengthens the
end-to-end proof and the degradation-review evidence only.

---

## Conclusion

The review kept grouping at analysis time, retained the measured 0.65 floor as
an every-pair constraint, added occurrence-level session provenance, and made
routing plus verification durable and cluster-scoped. The current 37-row live
corpus contains three compact groups inside one genuine candidate family but
cannot promote any of them because each lacks support, days, and sessions. The
implementation does not weaken those safeguards to manufacture acceptance
evidence.

---

## Second-pass review (if required)

**Reviewer:** independent CMT-1133 second pass
**Independent read of the artifact:** The first pass was not approved. It found
four substantive issues: exact-key-only sibling verification, unsafe
single-link chaining, a false excluded-pair measurement claim, and external
effects preceding non-atomic lifecycle updates. The implementation now uses
durable cluster ids with cluster-scoped recurrence, every-pair complete-link
admission with an A~B~C bridge regression, corrected live-corpus measurements,
and an atomic pre-effect cluster transition with an OCC-conflict regression.
The follow-up re-review found that `reopened` records had fallen out of the
verification scan; reopened clusters are now watched with a fresh start, with
second-window clean and max-cap regressions.
The reviewer-confirmed positives remain unchanged: `dedupeKey` is untouched,
the session migration is conservative/idempotent, kinds never mix, the job
stays disabled, and the read-only replay reports zero promotions.

**Final disposition:** APPROVED after the lifecycle fix. The independent final
run passed 59/59 focused tests, reproduced the read-only corpus replay, and
reported a clean diff check with no reviewer edits.

---

## Evidence pointers

- `docs/measurements/2026-07-30-correction-promotion-threshold.md`
- `scripts/correction-promotion-corpus-replay.mjs`
- `tests/unit/CorrectionAnalyzer.test.ts`
- `tests/unit/CorrectionLedger.test.ts`
- `tests/unit/CorrectionLoopDriver.test.ts`
- `tests/e2e/correction-learning-lifecycle.test.ts`
- `tests/unit/no-silent-fallbacks.test.ts`

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, reason: this change
modifies the evidence grouping and lifecycle bookkeeping of an existing
weekly/per-tick-bounded controller; it adds no new self-trigger, cadence, retry,
notify, spawn, restart, swap, re-drive, or kill emit. The existing
`maxRoutesPerTick` brake remains unchanged.
