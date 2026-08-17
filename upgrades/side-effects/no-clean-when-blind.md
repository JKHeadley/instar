# Side-Effects Review — No Clean Result While Blind

**Version / slug:** `no-clean-when-blind`
**Date:** `2026-08-17`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `not run — this session's governing policy prohibits spawning reviewer subagents unless the operator explicitly requests delegation`

## Summary of the change

Four fail-open observations now become explicit not-proven or failed-capture
results: attribution input reads, guard-posture source reads, semantic
conformance calls, and Human-as-Detector persistence. A recursive code-derived
checker-population ratchet in `scripts/lib/checker-blind-input-ratchet.mjs` is
wired into `npm run lint`; it refuses empty/unreadable populations, freezes the
legacy uncovered count at 91, and executes the five registered blind-input cases.
The standards contract and its operator-facing read surface are updated to make
not-proven a first-class result rather than allowing consumers to infer fit from
an empty finding list.

## Decision-point inventory

- `scripts/lint-llm-attribution.js` — modify — unreadable or unavailable input is a failing not-proven lint result.
- `GuardPostureProbe` — modify — unknown local/peer evidence produces a failed probe signal.
- `StandardsConformanceReviewer.review/judgeFit` — modify — unavailable judgment returns not-proven, never fit.
- `HumanAsDetectorLog.observe` — modify — a write failure preserves the correction signal and adds capture-failure evidence.
- `lint-checker-blind-input-coverage.mjs` — add — deterministic repository invariant preventing uncovered checker-population growth.

## 1. Over-block

The attribution lint will now reject a path that disappears between discovery
and read, and the class ratchet rejects a tree where either expected source root
is unavailable. Those are intentional hard-invariant failures: neither state
contains enough evidence for a clean lint result. Guard posture can now raise a
failed probe during a transient peer read failure; its description and error say
NOT-PROVEN rather than claiming an anomaly. Semantic review does not reject the
draft itself on outage, but it can no longer authorize closure as fit.

## 2. Under-block

The code-derived population relies on bounded naming/location conventions and
may miss a checker with an unrelated name outside the scanned roots. The legacy
uncovered population remains 91; the ratchet prevents growth and does not imply
retroactive executable coverage. A Human-as-Detector disk failure can prevent
the failed-capture row itself from reaching disk, so the fallback is an
in-memory record plus structured stderr. The fifth observed fail-open in
`scripts/instar-dev-precommit.js` remains separately recorded in the Phase B S3
report and is not represented as fixed here.

## 3. Level-of-abstraction fit

The runtime changes expose missing evidence at the source that owns it. They do
not invent a higher-level substantive judgment. The class ratchet operates one
level above individual checker tests: production code supplies the denominator,
the case registry supplies executable evidence, and a numeric ceiling ratchets
historical debt without an unreviewable per-file exemption list.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — runtime changes produce explicit signals consumed by existing surfaces.
- [x] Yes, deterministic blocking is limited to hard-invariant validation.

Guard posture and failed-capture evidence are signals. Semantic review keeps
ordinary work available but withholds the positive fit claim when judgment did
not occur. The two blocking scripts validate enumerable repository invariants:
inputs must be inspectable and checker coverage debt may not grow. This is the
documented hard-invariant exception, not a brittle attempt to judge message
meaning.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic decides between competing semantic signals. The only
new static decisions are source availability, exact registry identity, and a
code-derived integer ceiling. The semantic conformance result remains owned by
the existing context-rich reviewer; when it cannot judge, the value is
not-proven.

## 5. Interactions

- **Shadowing:** the class ratchet runs last in the existing lint chain; earlier lints still execute and report independently.
- **Double-fire:** a blind attribution input is reported by its own lint and can also fail the class case; both are test-time evidence, not duplicate runtime actions.
- **Races:** attribution discovery/read races are now explicit blind results. Human detector state remains in the existing synchronous in-process store.
- **Feedback loops:** none. No change retries, restarts, or writes back into checker discovery.

## 6. External surfaces

The standards response adds `conclusion` and may return `not-proven`; the fit
verdict union also adds `not-proven`. Human-as-Detector summaries add
`captureFailures`. These are additive response fields except that degraded fit
is intentionally no longer reported as `fit`. No external service calls, URLs,
approval forms, or operator actions are added.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, form, or operator action is changed. The existing JSON
read surfaces gain plain, explicit status fields; operator-surface layout is not
applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Mixed, deliberately source-owned: repository lints are machine-local by design
because they inspect the checked-out tree; conformance results are request-local;
failed detector captures report the local persistence failure; guard posture is
already pool-aware and now identifies which local or peer source is unknown.
There are no user-facing notices, generated URLs, or new durable replicated
state. The detector signal itself continues through the existing path even when
its local persistence fails, so topic transfer behavior is unchanged.

## 8. Rollback cost

Pure code and additive response-state change. Revert and ship a patch. No schema
migration or stored-state repair is required; in-memory failed-capture records
disappear on restart under either forward or rollback code.

## Conclusion

The change is clear to ship. The review narrowed authority carefully: blindness
may stop a repository proof or withhold closure, but it does not reinterpret the
underlying draft, user correction, or peer state as substantively bad. The main
known debt is explicitly counted at 91 and cannot increase unnoticed.

## Second-pass review

**Reviewer:** not run under the session's no-subagent policy
**Independent read of the artifact:** reduced assurance, stated rather than fabricated

The artifact was re-read against the live diff, the approved
`guard-enumeration-fail-visible` specification, and
`docs/signal-vs-authority.md`. No independent reviewer identity is claimed.

## Evidence pointers

- `scratchpad/phaseB/REPORT-S3.md` in the dispatch checkout contains commands, exit codes, and before/after output.
- `tests/unit/checker-blind-input-ratchet.test.ts` contains the executable class cases and P1–P5 anti-gaming tests.
- Focused tier runs: 90 behavioral tests, 14 integration tests, and 8 E2E tests passed.
- `npm run lint` executed the class ratchet and all ten of its tests.

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence:
{ enforcementType: ratchet, citation:
scripts/lint-checker-blind-input-coverage.mjs#MAX_UNCOVERED_CHECKERS,
howCaught: the production-derived checker denominator plus executable blind-input
cases refuses a new checker whose clean claim lacks evidence that its input could
actually be inspected }`.
