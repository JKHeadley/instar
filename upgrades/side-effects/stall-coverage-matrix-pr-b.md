# Side-Effects Review — framework-stall-coverage-matrix PR-B

**Change:** PR-B (second of the two staged PRs) of the framework-stall-coverage-matrix
standard (spec: `docs/specs/framework-stall-coverage-matrix.md`, converged + approved
2026-07-18; PR-A merged as #1512). Ships: the runtime apprenticeship gate
(`src/core/ApprenticeshipStallGate.ts` + worker), the acceptance/override machinery
(`src/core/ApprenticeshipMatrixAcceptance.ts` + two routes), the
`stall-matrix-live-check` job (+ driver script), install-provenance derivation +
one-time migrator backfill, the `/guards` load-bearing-soaking row, and the CLAUDE.md
template/migration section. Gate ships behind `apprenticeship.stallCoverageGate` with
inline default `{enabled: true, dryRun: true}` — observe-first, per the spec's
graduated rollout.

## Phase 1 principle check (recorded)

This change IS a decision point: it can refuse apprenticeship transitions (409).
Compliance shape: the gate's verdicts are the spec-classified INVARIANT half
(deterministic structural validation — presence, tokens, symbol resolution, ref
liveness, posture cross-check), executed in a bounded worker; every judgment call
(whether a covered claim is TRUE, acceptance of gaps/N-A/covered rows, degraded-mode
sign-off) is routed to an authenticated HUMAN principal via the challenge-bound
acceptance machinery — requester ≠ acceptor structurally (a bearer principal is
refused at bind). The fallback ladder ends deterministic: no valid acceptance → refuse
(no acceptance is ever inferred). This is Judgment-Within-Floors compliant: the floor
(schema/enumeration/liveness) is deterministic; the human holds the semantic choice.

## 1. Over-block

- The gate could refuse a legitimate completion on: a dead closePath ref (fix: reopen
  or re-status the row), a renamed detector symbol (fix: update the row), a stale
  acceptance after an edit (accept-then-edit voids by DESIGN — decision 20), a
  validator timeout (named retryable reason, distinct from invalidity), or an
  unreachable local server during liveness checks (named 'ledger-unreachable
  (retry)' — never conflated with matrix-invalid).
- Mitigations: ships dryRun (would-refuse logged, nothing blocked) until the operator
  flips enforce on named evidence; refusal reasons name class id + rule; the
  per-instance recorded override (row-scoped, content-bound, expiring) is the relief
  valve for a flaky check; pre-ship instances are grandfathered (warning-only) until
  the required-since minor.

## 2. Under-block

- Semantic truth of `covered` remains un-validated by machine — by explicit spec
  design; the acceptance enumeration puts every row class in front of the acceptor.
- The conversational acceptance arm binds on the operator's reply-anchor; a verified
  operator absent-mindedly replying "yes" to the wrong enumeration message binds that
  enumeration — bounded by the single-use challenge, the rendered set in the message,
  and hash re-resolution at bind (a changed matrix invalidates).
- While dryRun holds (the shipped state), NOTHING is enforced — the /guards
  load-bearing-soaking row (30-day window, declared 2026-07-18) makes an unflipped
  gate lapse into visible debt rather than rot ("A Dark Feature Guards Nothing"
  applied to this gate itself).

## 3. Level-of-abstraction fit

The gate is a separate module consumed by ApprenticeshipProgram through a nullable
seam — the transition chokepoint remains the single authority; the gate adds a branch
there rather than a parallel path. Validation executes in a worker (never the event
loop — instar#1069 posture); acceptance rides the existing challenge mechanics
(ScopeAccretionRatifier pattern + checkMandatePin funnel) rather than inventing a new
authority surface.

## 4. Signal vs authority compliance

The blocking surface is a deterministic invariant floor at a rare, human-paced,
audited transition — the documented exemption class — and it holds NO authority over
semantic meaning: those decisions belong to the PIN/verified-operator acceptor. No
brittle check gained authority over message flow or session behavior; day-to-day
sessions are untouched (Phase A cost boundary holds: gate work happens at transitions
and in the weekly job only).

## 5. Interactions

- transition()/evaluateCompletionGate() became async — all callers updated; the routes'
  409 mapping is unchanged in shape.
- The gate consumes the PR-A validator through the same deps seam CI uses — no
  double-fire (CI stays hermetic; gate adds only the non-hermetic checks).
- The live-check job overlaps the gate's non-hermetic checks by DESIGN (the job covers
  the standing seed matrices that never traverse a transition); both write distinct
  audit rows. Its mint flow files idempotent dedupKeyed issues + ONE aggregated
  commitment per pass — flood-safe by construction (aggregation, not per-element).
- The provenance backfill appends at most one decisions-log record (presence-scan
  idempotent); init and migrator cannot double-record.

## 6. External surfaces

Two new Bearer/PIN routes (CapabilityIndex updated); one Telegram enumeration message
per acceptance request (operator-initiated, never spontaneous); the weekly job ships
`enabled: false` fleet-wide with a silent no-op on no-source installs. No behavior
change for running sessions; restart applies the new server surfaces.

## 7. Multi-machine posture

Matrix artifacts + gate code: unified-via-git. Gate verdicts: derived-on-read against
the per-machine apprenticeship registry (the registry's declared machine-local
posture, operator-ratified in the spec's Multi-machine section); acceptance artifacts
and provenance records live in the gate machine's decisions log — coherent with
closePath refs resolving on the gate machine. The live-check job is
perMachineIndependent. No stranding: a topic transfer does not carry gate state
because the registry itself is machine-local by declared design.

## 8. Rollback cost

Config flag off ⇒ gate branch inert (matrices remain docs + tracked issues); revert
the PR for a full back-out — no data migration (decisions-log rows and acceptance
records are append-only audit, harmless to retain). The always-overwrite job template
un-ships with the revert; per-slug manifests preserve operator enabled-state
semantics. Cheapest rollback class for a gate: a flag read live at the callsite.

## Second-pass review

REQUIRED (gate + session-lifecycle-adjacent + blocking surface). Dedicated reviewer
subagent audits this artifact against the final diff independently.

### Second-pass reviewer response

**Concern raised (2026-07-18):** the row-scoped acceptance/override relief valve
was UNREACHABLE in production — the only shipped mint surface produced
whole-set/degraded challenges, so any row carrying an `acceptanceRef` (required
to clear `unreviewed`) would have failed `acceptance-ref-invalid` at enforce
time with no legitimate satisfaction path: a latent over-block behind the
dry-run. All other load-bearing properties were verified: dryRun suppresses
every refusal class through a single funnel; timeout and ledger-unreachable
verdicts are distinct and fail closed; bearer principals structurally refused
at bind; challenges single-use with replay refused; hashes re-resolved at
bind; refusal hygiene holds; multi-machine claims match the spec's declared
postures.

**Resolution (same session, pre-commit):** (1) the enumerate route is now
scope-aware (`rows` / `override` scopes mintable through the same PIN and
reply-anchor paths, Decision-20 canonical row hashing, `acceptanceRef`
excluded from row serialization to close the mint→bind→write-ref cycle) with
both-sides production-shaped route tests; (2) HTTP-error conflation fixed —
only 404/terminal means dead-ref, any other failure is ledger-unreachable
(retryable), in the gate AND the live-check script; (3) the aggregated
attention items now carry deterministic dedup ids (per matrix-state /
per-findings-set) — fixing, en route, a latent missing-required-id 400 on both
attention posts. Reviewer's remaining non-blocking observations (decisions-log
fabrication surface consistent with the declared tamper-evident threat model;
enumeration message formatting) accepted as noted. 296/296 tests green
post-resolution.

**Post-resolution status: concerns resolved; review concurs with the artifact
as amended.**

## Class-Closure Declaration

`unbounded-self-action` — closure: **n/a** (negative declaration). The gate's
actions are rare, human-paced, operator-driven transition evaluations — never a
self-triggered loop: attention posts carry deterministic dedup ids (one item per
matrix-state / per-findings-set; server-side dedup engages on retries), the
live-check job is an operator-enabled weekly cadence emitting ONE aggregated
attention item + ONE aggregated commitment per pass, and no respawn/kill/swap
surface is touched by this change.
