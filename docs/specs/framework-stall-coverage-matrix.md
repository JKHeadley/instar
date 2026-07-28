---
title: "Framework Stall-Coverage Matrix — session-stop classes are enumerated, covered-or-declared, continuously validated"
slug: "framework-stall-coverage-matrix"
author: "echo"
status: "draft"
created: 2026-07-17
parent-principle: "Structure beats Willpower"
sibling-principles: "Iterative Audit to Convergence; Close the Loop; No Silent Degradation to Brittle Fallback; Observation Needs Structure; Framework-Agnostic — and Framework-Optimizing; Testing Integrity; Verify the State, Not Its Symbol; Know Your Principal"
lessons-engaged: "CODEX-SESSION-WEDGE-SELF-RECOVERY.md (2026-06-03: the paused/input-not-draining class; its SessionRecoveryChannel WAS built but the emitter/consumer increments were abandoned mid-ladder — dangling half-built machinery, the stronger form of the debt); context-wedge sentinel (thinking-block wedge class, Claude-specific); AUP-rejection wedge; honest standby / StuckSignatureClassifier (alive ≠ working, Claude tail signatures); drive-5 defect #9 (2026-07-17: interrupted-conversation prompt after own-server restart — 2h silent stall, the loop's author never knew the class existed); 'A Dark Feature Guards Nothing' (a dark detector must never grade covered); framework-issues ledger + FRAMEWORK-ONBOARDING-MENTOR-SPEC (the onboarding surface); Standards Enforcement Coverage (existence + enforcement-strength + dangling-ref detection — all three halves, not just existence); instar#1069 (no whole-tree walks on the server event loop); evolution-loop starved-and-clogged (EVO-003: evolution-action refs are weak re-surfacing anchors); observe-mode-must-graduate (dry-run gates need an owned flip)"
origin: "Apprenticeship drive 5, defect #9 — operator directive 2026-07-17 (topic 29723): find the standard-level gap, not the bandaid"
eli16-overview: "framework-stall-coverage-matrix.eli16.md"
review-convergence: "2026-07-18T09:05:57.232Z"
approved: true
approved-by: "Justin (topic 29723, 2026-07-18 10:29 PDT: 'I approve all of the specs')"
review-iterations: 5
review-completed-at: "2026-07-18T09:05:57.232Z"
review-report: "docs/specs/reports/framework-stall-coverage-matrix-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 21
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Framework Stall-Coverage Matrix

## 1. Problem — stall classes are discovered one production incident at a time

Every framework session can stop in a bounded, enumerable set of ways. Instar has
learned these classes empirically, each at the cost of a silent production stall:

| Date | Class discovered | Cost |
|------|------------------|------|
| 2026-06-03 | paused-session, input not draining (codex) | manual lifeline+server restart by an external agent |
| 2026-06-05 | thinking-block context wedge (claude) | permanently dead session; fresh-respawn sentinel built |
| 2026-06-05 | AUP-rejection loop (claude) | second wedge signature added |
| 2026-07-17 | interrupted-conversation prompt after own-server restart (codex) | 2h+ silent drive stall — defect #9; the loop's author never knew the class existed |

The pattern: each framework's recovery machinery covers exactly the stall classes its
author has personally seen. The class SPACE is never enumerated up front, so every
un-encountered class is an invisible zero-coverage cell that fails silently in
production. Meanwhile the session registry reports a wedged session as `running` —
alive-but-failing — so nothing upstream notices (the honest-standby lesson, re-learned
per framework).

Claude sessions get the accumulated sentinel family (silently-stopped trio,
context-wedge, permission-prompt floor, resume queue). A codex/gemini/pi session
inherits almost none of it. The 2026-06-03 spec named this and built one increment
(`SessionRecoveryChannel`), then its remaining increments sat unbuilt for six weeks
with no re-surfacing cadence — which is exactly how defect #9 happened. Recovery is a
per-framework reimplementation with per-author blind spots AND an abandonment
lifecycle — a structural gap, not an implementation bug.

## 2. The standard (constitutional layer)

**Onboarding a framework into Instar REQUIRES a stall-coverage matrix: the enumerated
set of session-stop classes × this framework's detection + recovery story for each,
with every cell truth-typed, role-typed, and continuously re-validated. An empty cell
blocks onboarding sign-off; a declared gap requires recorded overseer acceptance; and
validation never stops at sign-off — a CI ratchet keeps every matrix current as the
class list grows and code changes.**

### 2.1 Canonical class registry (machine-readable, single source of truth)

The canonical stop-class list lives as a code constant — `src/data/stall-classes.ts`,
exporting `{ id, name, description, sinceVersion }` per class — imported by the
validator and every future consumer. The same module exports
`REQUIRED_MATRIX_FRAMEWORKS`, derived from the `IntelligenceFramework` union
(`claude-code | codex-cli | gemini-cli | pi-cli`; the canonical declaration is
`src/core/intelligenceProviderFactory.ts` — the duplicate union in
`src/messaging/shared/telegramRelayPrompt.ts` is non-canonical and should collapse)
so a framework cannot exist in the type without a matrix file being CI-required on
disk, and
`SENTINEL_KIND_TO_STALL_CLASS` — the static mapping from existing sentinel-event kinds
(`context-wedge`, …) to canonical class ids (existing emitters record kinds, not class
ids; this table is the enabling artifact for any future join — see §3.3). The spec's
table below MIRRORS the class list; a lint asserts the two agree, so prose and code
cannot drift.

Classes v1. **Primary classes are strictly proximate-observable-state; every stall
receives exactly ONE primary class — a deterministic REPORTING bucket, not a claim of
causal exclusivity** (several classes can co-present in a messy tail; the bucket is
where the stall is booked, the tags carry the rest). Where a live tail could
plausibly match more than one signature family, classification applies this
deterministic precedence order (first match wins): `wedged-context` >
`policy-rejection-loop` > `quota-wall` > `approval-prompt-wedge` >
`context-window-wall` > `input-not-draining` > `mid-turn-interrupt`. Rationale
(recorded so a future editor does not reshuffle it as arbitrary): descending
signature SPECIFICITY — a wedge/rejection signature is a positive textual match,
while interrupt/idle states are diagnoses of absence, so the positive match wins.
Examples of ambiguous tails: a transcript that fast-fails every resume AND mentions
usage limits books as `wedged-context` (the wedge signature is the more specific
match); a session idle at a resume prompt after its server died books as
`mid-turn-interrupt` only when no higher family matches the tail. Known cost of the
order: the newest class (`mid-turn-interrupt`, defect #9's class) sits last, so
ambiguous tails under-attribute to it — the arbiter and the §3.3 follow-up alarm are <!-- tracked: CMT-895 -->
the corrective loop. Causes are never
primary classes: `host-machine-loss` and similar causal facts are SECONDARY TAGS only
(e.g. a `mid-turn-interrupt` CAUSED by host loss carries tag `host-loss`); the mesh
owns machine-loss recovery, and the framework's obligation for that cause is honest
session state on return, recorded on whichever primary class the session lands in.
A `matchedClasses:` field records EVERY signature family that matched
alongside the primary reporting bucket — REQUIRED whenever more than one family
matches (omittable when exactly one matches); the validator preserves it even though
gates key only on the primary bucket — deterministic accounting without hiding
co-present failure modes.

| id | name | proximate observable state |
|----|------|---------------------------|
| `clean-turn-end` | Clean turn end | normal boundary; continuation machinery owns it |
| `mid-turn-interrupt` | Mid-turn interrupt | session at an interrupted/resume prompt after its host or server died mid-turn (defect #9) |
| `input-not-draining` | Paused / input not draining | session alive at idle prompt; delivered messages never start a turn (2026-06-03) |
| `wedged-context` | Wedged context | transcript poisoned; every resume fast-fails (thinking-block, AUP loop signatures) — recovery is fresh-respawn, never nudge |
| `policy-rejection-loop` | Policy/content rejection loop | every reply rejected; distinct signature from wedged-context, same terminal shape |
| `quota-wall` | Quota/rate-limit wall | turn fails on limits; recovery is wait-or-swap; truthful state must surface |
| `approval-prompt-wedge` | Permission/approval prompt wedge | blocked on an interactive prompt no remote user can answer |
| `context-window-wall` | Context-window wall | compact-in-place first, fresh-respawn fallback |

(Secondary tags v1: `host-loss`, `own-server-restart`, `network-partition` — causal
annotations, never a row of their own.)

**Class minting is a judgment-candidate decision point** (see `## Decision points
touched`): the floor is "a stall whose live signature no existing class's signature
family matches"; the arbiter is the overseer, promoting a `stall-class-candidate`-tagged
framework-issue into the registry by ordinary PR. An unpromoted
`stall-class-candidate` issue older than 30 days appears in the conformance sweep
report as an aging item, so an undecided candidate cannot rot silently.

**Discoverer protection (fully specified — auto-seeded debt is real debt, not
write-once rows):** adding a class runs the registry codemod (§3.4), which seeds a
`declared-gap` row (reason `new-class, unreviewed`) into every existing matrix in the
same PR, stamping each seeded row with `seededAt:` (ISO date). **The codemod is
offline-first** — it runs in a source checkout (a contributor clone, CI, the PR-race
repair path) with no instar server required: it writes `closePath: pending-mint`
(admissible only alongside a `seededAt:` stamp — the aging clock can never be
escaped by omitting the stamp),
which CI accepts format-wise. CI also hermetically rejects a `seededAt:` later than
the validation date — future-dating a seed cannot stall the aging clock. The MINT is owned by the recurring
`stall-matrix-live-check` job (§3.5): idempotent issue filing — one framework-issue
per seeded row with dedupKey `stallclass::<class>::<framework>::unreviewed` (the `::`
delimiter kills hyphen ambiguity between hyphenated class and framework ids) — plus
ONE aggregated open commitment per mint pass ("review the auto-seeded stall-class
rows from <class>"; owner: the development agent; topic: the drive/maintenance
topic), then a rewrite of `pending-mint` → the real ref via an ordinary PR within the
job's cadence. Cross-machine: minted closePath commitments live on the development
agent — the gate machine per the declared machine-local posture — so gate-time
liveness resolution is coherent by construction. **Aging ratchet (calendar-bound —
release counting is not a unit here; this repo shipped 527 consecutive patches on
one minor):** at `seededAt + 45 days` the live-check job / conformance sweep raises a
WARNING attention item (a `pending-mint` still unminted at 45 days escalates the same
way); at `seededAt + 60 days` a row still `unreviewed` turns the CI ratchet red — the
red is never the first signal. **Clearing `unreviewed` requires review, not a label
flip:** the row must carry an `acceptanceRef:` — a recorded acceptance per §2.2's
acceptance-authority mechanic (charset `^[A-Za-z0-9:_-]{1,64}$`, resolving into the
acceptance store `logs/apprenticeship-decisions.jsonl` on the gate machine) — whose
PRESENCE + format CI checks hermetically;
authenticity/liveness is checked at the gate and by the live-check job like every
other ref. The discoverer's own onboarding is never blocked by their discovery, and
existing matrices surface debt without fleet-red CI at the moment of minting.

### 2.2 Cell schema (truth-typed, role-typed)

Canonical machine tokens (lowercase, exact): `covered | covered-dark | declared-gap |
not-applicable`. Each row carries role-typed fields — **detector and recovery are
separate, both required for `covered`**; a row with recovery but no detector is
`declared-gap` by definition (detection before recovery — undetectable failures are the
expensive ones). Each row also carries `liveness-surface:` naming what the session
registry / standby reports while the class is active — the honest-liveness invariant as
a schema field, not prose (a registry `running` on a wedged session is itself a
defect).

- **`covered`** requires: `detector:` and `recovery:` symbols in `path/to/file.ts#Export`
  form, resolvable in the tree; a `guardKey:` (see below); a `posture: live`
  assertion consistent with the guards inventory (`/guards` classification — checked
  at the runtime gate and by the `stall-matrix-live-check` job, never by hermetic
  CI); and `evidence:` — a positive-control test or fixture path proving the detector
  fires on THIS framework's stall signature and the recovery path is reachable. The
  evidence file must CONTAIN the detector identifier, a `stall-class: <id>` marker
  for the class it evidences, AND a representative RAW stall signature for this
  framework (the actual tail/transcript text the detector matches — an identifier
  plus a marker in an unrelated test is compliance theater, not proof). An evidence
  path under `tests/` must be in the push suite's EFFECTIVE collected set — the
  include globs MINUS the maintained exclusion list (`FLAKY_TESTS`); an evidence
  file in the exclusion list, or whose evidence blocks carry ANY vitest skip-class
  modifier (`describe.skip`/`it.skip`/`xit`/`xdescribe`/`it.todo`/`it.skipIf`/…),
  FAILS the check (a test no runner executes proves
  nothing — and exclusion is this repo's documented rot vector). The check is static
  glob-and-list matching against the push config, not suite execution. A pure
  fixture must be referenced FROM an effectively-collected test. Evidence tests use
  the standard assertion helper `expectStallDetectorFires({ framework, classId,
  fixture })`, shipped with the validator — hand-rolled equivalents remain legal
  when they carry the identifier + marker. Symbol existence
  alone NEVER earns `covered` (Verify the State, Not Its Symbol).
- **`guardKey:` (REQUIRED on `covered` and `covered-dark` rows)** — the explicit join
  key into the guard manifest/inventory, validated to EXIST there; the
  (guardKey, detector) pair is enumerated in the gate report so the acceptor judges
  the binding (without it, the posture cross-check has no defined join — a row could
  borrow any conveniently-postured guard). Components deliberately EXEMPT from the
  guard manifest (e.g. `StuckSignatureClassifier`, a pure classifier with no enabled
  switch, exempted at `src/monitoring/guardManifest.ts`) declare
  `guardKey: exempt:<manifest-exemption-id>` — the posture check then records
  vacuous-with-reason in the gate report. No inventory row AND no exemption entry ⇒
  the row FAILS.
- **`covered-dark`** — the machinery exists but ships dark/dry-run for this fleet.
  A covered-dark row carries the SAME resolvable `detector:`/`recovery:` symbols and
  `guardKey:` as `covered`, PLUS the guards cross-check at the gate — the row's
  `guardKey` must classify dark/dry-run in `/guards`, NOT missing (a fiction labeled
  covered-dark fails structurally) — PLUS a `closePath:` ref for the flip-live debt.
  **The gate treats `covered-dark` as `declared-gap` for sign-off purposes** ("A Dark
  Feature Guards Nothing") — it exists as a distinct token so the debt is legible as
  "flip it live" rather than "build it".
- **`declared-gap`** requires: `issueRef:` (a framework-issues `dedupKey`, charset
  `^[a-z0-9:-]{1,80}$` — colons admitted for the `::`-delimited seeded keys) AND
  `closePath:` (charset `^[A-Za-z0-9:_-]{1,64}$`; the `pending-mint` placeholder
  satisfies that charset and is legal ONLY on a row carrying `seededAt:`, whatever
  authored it;
  CI hermetically FAILS any `pending-mint` row without `seededAt`, and the
  live-check job mints for ANY `pending-mint` row regardless of origin) — a tracked ref giving the gap a re-surfacing cadence (Close the
  Loop: a ledger row alone is write-once abandonment — the 2026-06-03 spec's own
  lifecycle proves it). closePath refs SHOULD be commitment refs (commitments ride
  the live PromiseBeacon cadence); evolution-action refs are accepted but
  disfavored — that queue is documented starved-and-clogged (EVO-003), so an action
  ref is a weaker anchor. closePath LIVENESS is verified at the gate callsite (§3.2)
  AND on a cadence by the `stall-matrix-live-check` job (§3.5) — both provably run
  and reach the ledger: the ref must resolve to an OPEN commitment/action; a dead
  ref flags the row and raises one aggregated attention item. **Closing the loop
  closes the row, not just the ref:** delivering/closing a commitment that is a
  matrix closePath requires re-statusing the referencing rows in the same motion —
  the gate and the live-check job treat a delivered-commitment closePath as a DEAD
  ref otherwise (a closed anchor is no anchor). The gate report ENUMERATES every
  declared gap for recorded acceptance at sign-off; classes with a named production
  incident in §1's table cannot pass as `declared-gap` without that explicit
  acceptance line in the audit.
- **`not-applicable`** requires a falsifiable structural reason — the named
  architectural invariant that makes the class impossible for this framework, not
  prose ("stateless CLI: no persistent transcript exists to wedge") — plus a
  `revalidateOn:` trigger (framework version / transport / session-mode change /
  framework-revival). N/A rows are ENUMERATED in the gate report for review (the gate
  proves they were presented; the mind judges the reason). **A production incident
  matching a `not-applicable` cell reclassifies it to `declared-gap`** — an N/A
  proven wrong is worse than a declared gap. The reclassification is OWNED by the
  recurring conformance sweep: the sweep raises ONE deduped (per
  class × framework) HIGH attention item and opens a proposed codemod PR — it NEVER
  performs a direct runtime write to the repo (matrices are git-tracked; a server
  process mutating a checked-out tree races in-flight PRs and violates the
  SourceTreeGuard posture). `revalidateOn` triggers are likewise sweep-checked (the
  sweep compares each matrix's recorded framework version against the installed CLI
  and flags trigger hits). Honesty note: the conformance sweep is dev-gated dark on
  the fleet today, so these clauses bind the development agent's sweep until that
  feature graduates — the spec names this rather than inheriting it silently.

**Acceptance authority (Know Your Principal).** Every recorded acceptance this
section requires — declared gaps, N/A reasons, covered rows (§3.2), degraded-mode
verdicts (§3.2), `unreviewed` clears (§2.1) — must be bound to an authenticated
principal DISTINCT from the transition caller: a dashboard-PIN-authenticated
operator action or the verified-operator surface. The gate REFUSES an acceptance
whose recorded principal equals the requesting agent (requester ≠ acceptor,
structurally — the same agent that drives a transition holds the Bearer token, so a
Bearer-recorded "acceptance" would be self-approval). **The acceptance ARTIFACT is
defined once, here, and every acceptance in this spec uses it:**
`{ contentHash, enumerated row ids accepted, authenticated
principal, challenge ref }`, minted by the SAME server-enumerates → operator-replies
challenge mechanic as the existing autonomous ratify-deferral flow — the server <!-- tracked: 29723 -->
renders the exact enumerated set, the operator's authenticated reply binds exactly
that set, the challenge is SINGLE-USE (replay refused). **Binding granularity is
scoped to intent:** a ROW-SCOPED acceptance (`acceptanceRef:` on a row, a
per-instance override) binds its `contentHash` to the canonical serialized content
of exactly the accepted row(s) — so a codemod adding UNRELATED rows does not void
standing row acceptances (class growth must not be a human-acceptance churn
generator); a TRANSITION-TIME whole-set acceptance binds to the whole-matrix
content hash, where re-review on ANY change is precisely the intent.
An acceptance whose bound hash does not match the CURRENT content of its scope is
INVALID — accept-then-edit voids it, and a recorded acceptance can never satisfy a
later transition over changed rows. A prose claim of acceptance — an agent-authored file
asserting the operator accepted — is structurally insufficient by construction
(fabricated-principal confabulation is a documented fleet failure class; the
challenge ref is the anti-body).

### 2.3 When the matrix is required

- **Provisional matrix at `pending→active`** (framework-onboarding instances created
  after ship): before live/on-task operation, a provisional matrix must exist — rows
  may be mostly `declared-gap`, but the enumeration is complete. The production
  incidents in §1 happened DURING active use; a gate only at completion fires too late.
- **Full matrix at `active→complete`**: verified from live state at transition time;
  the validator's verdict (schema + statuses + acceptance enumeration) decides
  validity; refusal is a 409 whose reasons name the class id and the violated rule —
  never quoting rejected raw field content (content that failed validation is exactly
  the content the clamps exist to keep out of downstream surfaces).
- **Gate seam (explicit):** the matrix check is a SINGLE new branch inside the
  existing completion gate — the real seam is `evaluateCompletionGate()` consumed by
  `transition()` in `src/core/ApprenticeshipProgram.ts`, surfaced as
  `/can-complete` — gated ENTIRELY by
  `apprenticeship.stallCoverageGate` (§3.4) — under `dryRun:true` BOTH the presence
  and validity refusals are suppressed and only a would-refuse verdict is logged.
  The `pending→active` provisional-matrix check wires as a sibling branch in the
  SAME place the existing retro-gate runs inside `transition()` (the pending→active
  arm), gated by the same `apprenticeship.stallCoverageGate` flag — `dryRun`
  suppresses it identically. Provisional validation depth is the hermetic checks
  ONLY (schema, complete class enumeration, token legality, ref format) — never the
  non-hermetic gate checks (liveness/guards), which belong to `active→complete`. The
  requirement is derived from a canonical checklist function of
  `(instanceType, createdAt)` — NOT from the per-instance immutable
  `requiredArtifacts` flags; this is a deliberate, named change to that design for
  this artifact class (per-instance flags remain authoritative for the three legacy
  artifacts; the matrix requirement is registry-canonical so it can evolve without
  rewriting instances).

## 3. Mechanical arm (what gets built)

### 3.1 Matrix artifact format

One file per framework: `docs/frameworks/<framework>-stall-coverage.md`. Machine
content is a YAML front-matter block (`stall-coverage:` — one entry per class id with
the §2.2 fields); the markdown body is free-form for humans. Input hygiene at the
validator edge: symbol/path fields charset-clamped (`^[A-Za-z0-9_./#-]{1,128}$`) AND
any path containing a `..` segment is rejected at the clamp; all detector / recovery /
evidence paths are resolved relative to the repo root and realpath-jailed inside the
tree before any read; symbol-check target files are read under a 1MB cap (only the
matrix file itself was capped before — an unjailed, uncapped symbol path is an
arbitrary-file existence-and-substring oracle plus a fail-closed DoS lever).
Free-text fields length-capped (256 chars), row count capped (64), file size capped
(256KB). Any surface quoting matrix free-text into an LLM context or notification
wraps it in the existing untrusted-data envelope convention; validator refusal
messages reference class id + rule name only and never echo rejected content.

### 3.2 One validator, two callsites

A single validator module, invoked from:

1. **CI ratchet (the continuous half — this is the primary enforcement).** A repo
   test living in the whole-tree push suite (`vitest.push.config.ts` — so the Husky
   pre-push hook and CI both run it; targeted runs miss whole-tree ratchets)
   validates the matrix set on every push: a matrix file EXISTS for every framework
   in `REQUIRED_MATRIX_FRAMEWORKS` (deleting a matrix is a red build, not a silent
   pass); schema; exact status tokens; canonical-class completeness (from
   `stall-classes.ts`); symbol existence for `covered`/`covered-dark` rows (file
   exists AND the identifier appears in it — the conformance-audit mechanic, under
   the §3.1 jail + read cap); evidence containment (the detector identifier, the
   `stall-class: <id>` marker, and the raw-signature requirement's marker presence in
   the evidence file — an `expectStallDetectorFires({ framework, classId, fixture })`
   helper invocation is accepted as the canonical form of the identifier+class-marker
   requirement, hand-rolled equivalents legal when they carry the identifier +
   marker; a `tests/` evidence path present in the push suite's EFFECTIVE
   collected set — include globs MINUS the exclusion list — with skip-marked
   evidence blocks refused; static glob-and-list matching, not suite execution);
   `guardKey` presence + format on covered/covered-dark rows; the `unreviewed`
   calendar aging ratchet + `acceptanceRef` presence/format (§2.1); and
   spec-table/registry agreement. A canonical class addition or a renamed
   detector symbol turns the affected matrices red on the NEXT PUSH unless the same
   PR ran the codemod — matrices cannot rot between onboardings. Issue-ref and
   closePath liveness are NOT checked here — CI stays hermetic (format only);
   liveness belongs to the gate callsite and the conformance sweep.
2. **Runtime gate callsite.** The apprenticeship transition calls the same module.
   On installs WITH an analyzable instar source tree: full validation, PLUS the
   non-hermetic checks CI cannot do — closePath resolves to an OPEN
   commitment/action (dead ref ⇒ row flagged + one aggregated attention item), and
   `posture:` assertions cross-checked against the live `/guards` classification
   VIA each row's `guardKey` join (covered ⇒ live; covered-dark ⇒ dark/dry-run, not
   missing; `exempt:*` ⇒ vacuous-with-reason recorded), with the (guardKey,
   detector) pairs enumerated in the gate report. The degraded rung binds to
   INSTALL PROVENANCE, not a runtime filesystem probe: the install class is DERIVED
   at init and appended tamper-evidently to `logs/apprenticeship-decisions.jsonl`
   (never a live agent-writable config field), and that recorded class decides.
   Existing installs that predate this feature get a ONE-TIME tamper-evident
   backfill at update time: the PostUpdateMigrator derives the install class with
   the same logic init uses and appends the same decisions-log record (idempotent —
   skipped when a record already exists). A source-absent install with NO provenance
   record after migration REFUSES with the named reason
   `provenance-record-missing — re-run update/migration`, never silently degrades. On a fleet npm-package install (no `docs/` ships): the
   verdict is `matrix-unverifiable-no-source`, recorded in the gate report, and the
   authenticated overseer-acceptance path (§2.2) carries the sign-off — mirroring
   the doorways-registry `registry-unavailable-no-instar-source` pattern; NEVER a
   presence-check refusal for a reason unrelated to matrix quality. On an install
   whose provenance says source-carrying (repo-gated / `developmentAgent`), a
   missing or unanalyzable tree is a REFUSAL with a named reason — never a
   degrade-to-acceptance (otherwise the transition caller could manufacture the
   acceptance-only path by pointing the gate at a stripped checkout). Execution is a
   bounded child process (never the server event loop — instar#1069; default timeout
   60s — the operation is rare and human-paced), single-read with the content hash of
   exactly what was validated — plus the checkout's HEAD SHA and dirty flag —
   recorded in `logs/apprenticeship-decisions.jsonl` (no validate-then-decide
   TOCTOU). A validator timeout fails CLOSED for the transition with a named reason
   that distinguishes "validator timed out (retry)" from "matrix invalid". The
   matrix path is derived exclusively from the registry's charset-clamped
   `framework` field, realpath-jailed to `docs/frameworks/`.

**The validator's verdict is STRUCTURAL, never semantic** — row present, tokens legal,
symbols resolvable, evidence marked and collected, refs live. Whether a `covered`
claim is TRUE stays with the overseer (the mind). The gate report enumerates COVERED
rows (with their evidence paths) for the same recorded acceptance as gaps and N/As —
the path of least scrutiny must not be the strongest claim. The validator emits
per-row `mechanically-verified: presence-only` so no downstream surface can present
`covered` as proven.

### 3.3 Observability (tracked follow-up increment — not this build) <!-- tracked: CMT-895 -->

The full metering surface — per-framework status counts, gap-count trend, and the
per-class detection-fires/recovery-outcomes join — is a FOLLOW-UP increment of the <!-- tracked: CMT-895 -->
conformance-coverage report family, carried as its own tracked ref created by this
spec's build (recorded in the PR body, exactly like the recovery service — never an
ambient follow-up). It is not buildable as a silent rider: existing sentinel events <!-- tracked: CMT-895 -->
carry kinds, not class ids, and joining them requires the
`SENTINEL_KIND_TO_STALL_CLASS` mapping THIS build ships (§2.1) plus bounded read
machinery (a `sinceHours` window or off-loop snapshot à la the cartographer pattern —
`logs/sentinel-events.jsonl` grows without bound and must never be full-parsed on the
server event loop). The follow-up's spec owes: the join's storage/derivation, a <!-- tracked: CMT-895 -->
concrete suspect-cell alarm condition (covered cell + ≥N incidents in class + 0
detector fires ⇒ attention item — passive "visible as suspect" is not a loop), and a
`machinesCovered` scope tag (the logs are per-machine; a pool-scope merge is a later
increment of the same family).

### 3.4 Growth, migration, rollout, rollback

- **New-class migration:** the class-registry codemod (a named §3.5 deliverable)
  auto-seeds `declared-gap (new-class, unreviewed)` rows — `seededAt`-stamped, with
  `closePath: pending-mint` per §2.1's offline-first contract (the live-check job
  owns the mint + ref rewrite) — into every existing matrix in the same PR that adds
  the class. The codemod is offline-first (no server dependency; runnable from any
  contributor clone or CI) and idempotently re-runnable against a merged tree: when
  two green PRs race (a class addition and a new matrix in flight), the merge of the
  second reds the ratchet and the failure message names the one-command fix (run the
  codemod, commit the seeded rows).
- **Instance migration parity:** two code constants pin the boundary —
  `STALL_MATRIX_REQUIRED_SINCE` (a minor version, e.g. `1.4.0`) and
  `STALL_MATRIX_SHIP_DATE` (the ISO date the gate wiring ships). Pre-ship instances
  (`instance.createdAt < STALL_MATRIX_SHIP_DATE`) are grandfathered with a warning
  row on `can-complete` while `currentVersion` is below the required-since minor;
  from that minor on, required. Both predicates are deterministic on every machine
  and every release (patch releases ship many times a day — "one release" is not a
  unit). Post-ship framework-onboarding instances read the requirement live from the
  canonical checklist function (§2.3).
- **Rollout:** gate wiring ships behind `apprenticeship.stallCoverageGate` in
  `.instar/config.json`, read LIVE at the gate callsite (no restart; transitions are
  rare and human-paced, and a boot-cached flag is the "applied config change didn't
  take" trap). The default is inline in code — absence ⇒ `{enabled: true,
  dryRun: true}` — so no `migrateConfig()`/PostUpdateMigrator entry is needed; a
  malformed block resolves to the safe default (dry-run) with a loud log line.
  Dry-run logs the would-refuse verdict on `can-complete`/`transition` without
  blocking. While dry-run, the gate registers in the `/guards` inventory as
  load-bearing-soaking with a soak deadline, so an unflipped gate lapses into
  visible debt instead of rotting ("A Dark Feature Guards Nothing" applies to this
  spec's own gate, not just its matrix cells). The enforce flip is OPERATOR-owned,
  on named evidence — clean validation of all four seed matrices plus a bounded
  dry-run soak with the would-refuse log reviewed — and is recorded as a commitment
  in the build PR (observe-mode-must-graduate: a condition without an owner and a
  ref is how dry-run modes rot).
- **Rollback:** flag off ⇒ matrices remain inert docs + tracked framework-issues; no
  state cleanup required. Per-instance relief for a flaky symbol-check is a NEW
  recorded override added to this build's scope — acceptor identity + reason,
  authenticated per §2.2's acceptance-authority rule, BOUND (row-scoped per §2.2's
  binding-granularity rule) to the canonical serialized content of the named
  rule/row it excuses, EXPIRING on any change to that row, and recorded in `logs/apprenticeship-decisions.jsonl` (an unbound override
  would reopen the validate-then-decide TOCTOU the gate closes elsewhere). (The
  previously-cited "existing operator-ratification path" does not exist as a general
  mechanism; the only acceptance machinery today is retro-harvest-specific, and
  citing it would be a dangling ref.)
- **Agent awareness + migration parity:** the CLAUDE.md template
  (`generateClaudeMd()`) gains the apprenticeship-gate addition — the new refusal
  class, the config knob, and the "matrix unverifiable on no-source installs"
  honesty line — and `migrateClaudeMd()` gains the content-sniffed section so
  existing agents receive it on update. Both are §3.5 deliverables.

### 3.5 Deliverables of THIS spec's build (in scope, single run)

1. `src/data/stall-classes.ts` — class registry + `REQUIRED_MATRIX_FRAMEWORKS`
   (derived from the `IntelligenceFramework` union) + `SENTINEL_KIND_TO_STALL_CLASS`
   mapping table.
2. Validator module + CI ratchet test (in the whole-tree push suite) +
   gate-callsite wiring behind the live-read dry-run flag + the per-instance
   recorded-override relief path + the class-registry codemod (offline-first,
   idempotent, `pending-mint` seeding — §2.1/§3.4).
2b. **The `stall-matrix-live-check` job** — a small recurring dev-agent job (tier-1
   supervised, weekly cadence; ships off-by-default on the fleet exactly like other
   repo-gated jobs, ON for the development agent) that runs the SAME validator's
   non-hermetic checks — closePath liveness, guardKey/posture cross-check, dead-ref
   flagging, the 45-day warning rung, `pending-mint` minting + ref rewrite — over
   ALL matrices in `docs/frameworks/`, raising the same aggregated attention item on
   failures. This is the recurring live checkpoint that provably reaches the seed
   matrices, which never traverse an onboarding transition — without it, every
   non-hermetic guarantee is unreachable for the only four matrices that exist at
   ship (the transition gate fires for FUTURE onboardings; the job covers the
   standing fleet).
3. **Seed matrices for ALL FOUR frameworks.** `claude-code`: mostly
   covered/covered-dark, written down for the first time. `codex-cli`: honest
   zeros — each `declared-gap` filed to the framework-issues ledger
   (`POST /framework-issues/observe`, bucket `instar-integration-gap`) and paired
   with its `closePath` ref as part of the run. `gemini-cli`: honest
   all-declared-gap/not-applicable (framework currently dead upstream;
   `revalidateOn: framework-revival`). `pi-cli`: honest rows for a ships-dark
   framework. Minutes of authoring for the latter two; no detector work owed to a
   dead framework — but the ENUMERATION is complete, which is the spec's entire
   thesis (a partial matrix-file set re-creates §1's invisible-zero-cell failure one
   level up). Seed matrices for already-onboarded frameworks never traverse an
   onboarding transition, so they carry a one-time recorded operator
   acceptance — minted through §2.2's challenge mechanic (dashboard-PIN;
   content-hash-bound to the seed matrices as shipped) once PR-B's acceptance
   machinery is live, BEFORE the enforce flip; the PR body records the challenge
   ref THEN (per the staged-landing plan below), not at PR-A ship. An
   agent-authored prose claim of acceptance is structurally
   insufficient — on a fleet running green-PR auto-merge, a prose "operator
   accepted" file could merge with zero human contact (the human half of the
   covered-claim loop must genuinely fire at least once).
4. The STANDARDS-REGISTRY.md entry lands in the SAME PR as the validator (guard and
   prose ship atomically — the conformance audit sees `ratchet`, never a dangling
   ref).
5. CLAUDE.md template addition (`generateClaudeMd()`) + `migrateClaudeMd()`
   content-sniffed migration (§3.4).

**Staged landing:** §3.5 lands as TWO staged PRs — PR-A: registry + validator + CI
ratchet + codemod + seed matrices (shipping in `pending-mint`/unaccepted state);
PR-B: runtime gate wiring + acceptance/override machinery + the live-check job.
The seed matrices' one-time PIN acceptance is minted once PR-B's acceptance
machinery is live, BEFORE the enforce flip; its challenge ref is then recorded. A single batch is too
much integration risk for a safety-relevant gate; each PR carries its own
side-effects artifact per the instar-dev ceremony.

Out of scope, durably tracked (each with its own recorded ref created by this
spec's build, in the PR body — never an ambient follow-up): (a) the long-term <!-- tracked: CMT-894 --> <!-- tracked: CMT-895 -->
framework-agnostic stall-recovery service (detectors parameterized by per-framework
signatures, shared recovery ladders); (b) the §3.3 observability/metering surface.
**Ref TYPE constraint:** both follow-up refs MUST be open commitments or <!-- tracked: CMT-894 --> <!-- tracked: CMT-895 -->
maturation-track items with a review cadence — NEVER evolution-queue refs (the same
liveness bar §2.2 applies to declared-gap rows; an evolution-queue ref is exactly
the weak anchor this spec forbids for matrix rows, and a PR-body ref with no live
re-surfacing cadence is the 2026-06-03 abandonment lifecycle this spec exists to
close).

## 4. Non-goals and cost boundary

- This spec does NOT build new sentinels; it makes missing ones visible, priced, and
  continuously re-validated at the right moments (onboarding + every push).
- It does not gate day-to-day sessions. Phase A adds no per-session runtime cost:
  validation runs at CI time and at rare, human-paced transitions in a bounded child
  process. Read surfaces (the §3.3 metering) are follow-up increments with their own <!-- tracked: CMT-895 -->
  cost budgets; the future recovery service's detector-polling budget is an explicit
  open item for ITS spec, not an inherited assumption.

## 5. Tests

Tier mapping (Testing Integrity, explicit): unit → `tests/unit/` (validator
semantics, every boundary below); integration → `tests/integration/` (the real HTTP
transition pipeline: 409s, dry-run suppression, malformed-config default); e2e →
`tests/e2e/` (gate lifecycle over a fixture with the decision-record audit).

- **Wiring integrity:** the apprenticeship completion gate delegates to the REAL
  validator (not null, not a no-op) and consumes its verdict — a gate wired to a stub
  fails this test.
- **Semantic correctness, both sides of every boundary:** `covered` with live
  symbols + marked-and-collected evidence passes / with a dead symbol fails / with
  detector==recovery fails / with posture contradicting the guards inventory fails
  (at the GATE callsite — posture is never a CI check); evidence file exists but
  lacks the detector identifier or the `stall-class:` marker ⇒ fails; a `tests/`
  evidence path outside the EFFECTIVE collected set ⇒ fails — including the two
  exclusion sides: evidence file present in the push suite's exclusion list ⇒ fails,
  and an evidence block carrying any vitest skip-class modifier
  (`describe.skip`/`it.skip`/`xit`/`xdescribe`/`it.todo`/`it.skipIf`/…) ⇒ fails;
  covered/covered-dark row without `guardKey` ⇒ fails; `guardKey` naming no
  inventory row and no manifest exemption ⇒ fails; `guardKey: exempt:<id>` with a
  real manifest exemption ⇒ passes with vacuous-with-reason recorded; `covered-dark`
  with resolvable symbols + dark-classified guardKey + closePath passes / with a
  missing guard or no closePath fails, and is treated as gap at the gate;
  `declared-gap` with well-formed issueRef + closePath passes format checks /
  without either fails; closePath resolving to a closed/dead ref ⇒ row flagged
  (gate/live-check test); a delivered commitment still referenced as a closePath
  without the rows re-statused ⇒ dead ref;
  `not-applicable` with a structural reason + revalidateOn passes / without fails;
  missing class row fails; missing matrix file for a `REQUIRED_MATRIX_FRAMEWORKS`
  member fails; a path containing `..` or escaping the repo jail is rejected;
  refusal output never contains rejected raw field content.
- **Fleet-regression (the additive-growth test):** adding a class to
  `stall-classes.ts` WITHOUT the codemod fails every stale matrix on the next push;
  running the codemod seeds `declared-gap (new-class, unreviewed)` rows WITH
  `seededAt` stamps + `pending-mint` closePaths and CI passes green with the debt
  visible; a seeded row still `unreviewed` at `seededAt + 60 days` turns CI red,
  and clearing it without an `acceptanceRef` ⇒ still red (label-flipping is not
  review); the 45-day warning rung raises before any red; a `seededAt:` dated later
  than the validation date ⇒ fail (future-dating cannot stall the aging clock).
- **Degradation honesty:** validator on a fleet-provenance (no-source) install
  yields `matrix-unverifiable-no-source` in the gate report (never a presence
  refusal); on a source-carrying-provenance install with a missing/unanalyzable
  tree the transition is REFUSED with a named reason (the degrade path cannot be
  manufactured); validator timeout refuses the transition with a reason
  distinguishing timeout from invalidity.
- **Acceptance authority:** an acceptance recorded by the transition-calling
  principal is refused (requester ≠ acceptor); a dashboard-PIN challenge acceptance
  passes; an acceptance whose contentHash mismatches the current matrix is refused
  (accept-then-edit); a reused challenge ref is refused (replay); an override not
  matching the current content hash / named rule is inert.
- **Integration:** `active→complete` refused (409, class-id + rule-name reasons) on
  absent/invalid matrix under `dryRun:false`; would-refuse logged (presence AND
  validity both suppressed) under `dryRun:true`; `pending→active` refused (409,
  named reasons) on an absent/invalid provisional matrix under `dryRun:false`,
  would-refuse logged under `dryRun:true`; malformed config block resolves to
  dry-run with a loud log.
- **E2E:** onboarding fixture with complete matrix passes; removing one row blocks;
  the gate decision record carries the validated content hash + checkout HEAD SHA +
  dirty flag.

## Decision points touched

| Decision point | Classification | Notes |
|----------------|----------------|-------|
| Per-row schema/status verdict (validator) | invariant | deterministic parse + token check; no judgment |
| Symbol/evidence existence + containment check | invariant | deterministic file+identifier+marker resolution under the path jail (conformance-audit mechanic) |
| Gate refusal on absent/invalid matrix | invariant | rides the existing audited transition gate; 409 + class-id/rule-name reasons |
| Acceptance of declared-gap / not-applicable / covered / degraded-mode verdicts | judgment-candidate | floor: the gate enumerates every row class and blocks silent passage; the acceptance artifact is content-hash-bound + challenge-anchored + single-use (§2.2); arbiter: an authenticated principal distinct from the transition caller (dashboard-PIN / verified-operator — requester ≠ acceptor enforced); fallback ladder ends deterministic (no valid acceptance recorded → refuse) |
| Canonical class minting | judgment-candidate | floor: "a stall whose live signature no existing class's signature family matches"; arbiter: overseer promotes a `stall-class-candidate` framework-issue by PR; deterministic rung: no promotion → no registry change, the incident stays a tracked issue; 30-day aging surface on undecided candidates |
| Incident→class matching (N/A reclassify, recurrence attribution) | judgment-candidate | floor: the incident's live signature must match the class's signature family (deterministic precedence order §2.1 for ambiguous tails); arbiter: overseer, via the sweep-raised attention item + proposed codemod PR; deterministic rung: no match / no decision → no reclassify, the incident stays a tracked issue |

## Multi-machine posture

- **Matrix artifacts** (`docs/frameworks/*.md`): unified-via-git — repo-tracked files;
  the freshness caveat (a stale checkout on one machine) is bounded by the CI ratchet
  being the primary enforcement, and the gate decision record carries the checkout
  HEAD SHA + dirty flag so a stale-checkout verdict is auditable.
- **Validator verdict:** derived-on-read; no stored state.
- **Gate wiring:** rides the apprenticeship registry's existing per-machine state.
  machine-local-justification: operator-ratified-exception —
  APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC declares the program registry's state
  per-machine ("the multi-machine pool keeps per-agent state on its owning machine",
  landed in commit `d0fe838dbf92c091a28bcf005a1bd7c79b5eaf91`, which a CI job can
  confirm contains `docs/specs/APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC.md`). The
  gate's verdict is derived-on-read against that per-machine record; closePath refs
  resolve on the gate machine (consistent with the registry's declared posture). The
  transition must run on a machine holding an analyzable instar source tree for full
  validation; §3.2's `matrix-unverifiable-no-source` verdict + authenticated
  acceptance covers the rest, named in the report.
- **Observability read surface:** deferred to the tracked §3.3 follow-up, which owes <!-- tracked: CMT-895 -->
  the `machinesCovered` scope tag; a pool-scope merge is a later increment of the
  conformance-coverage family, not this spec.

## Frontloaded Decisions

1. Canonical class list lives in `src/data/stall-classes.ts`; spec table mirrors it;
   lint asserts agreement. Additive-only; class additions by ordinary PR.
2. Matrix format: YAML front-matter (`stall-coverage:` entries) + free markdown
   body, in one file. Chosen over a schema-first standalone YAML: the repo's spec
   convention is front-matter + human body in ONE reviewable artifact, the validator
   is custom either way, and splitting machine/human content across two files
   invites drift between them; the strict §3.1 clamps + §5 tests carry the rigor a
   JSON-schema would.
3. Status tokens: lowercase `covered | covered-dark | declared-gap | not-applicable`.
4. Symbol format: `path/to/file.ts#ExportedName`; existence = file exists AND
   identifier appears in it — resolved from repo root, realpath-jailed, `..`
   rejected, 1MB read cap.
5. Validator: one module, two callsites (CI ratchet = primary, in the whole-tree
   push suite; gate = live-state check). CI is hermetic (ref format only);
   closePath/issueRef liveness + posture cross-check belong to the gate callsite and
   conformance sweep.
6. Gate execution: bounded child process (60s default timeout), single-read +
   content-hash + HEAD-SHA/dirty-flag audit, timeout fails closed with a
   timeout-vs-invalid distinguishing reason, path jailed to `docs/frameworks/`.
7. issueRef = framework-issues `dedupKey` (charset `^[a-z0-9:-]{1,80}$`; seeded keys
   use `::` delimiters); closePath = commitment ref (preferred —
   PromiseBeacon-backed) or evolution-action ref (accepted, disfavored per EVO-003),
   charset `^[A-Za-z0-9:_-]{1,64}$` (the `pending-mint` placeholder satisfies it;
   legal only on a `seededAt:`-stamped row); both fields required for
   `declared-gap`; liveness verified at the gate AND by the live-check job.
8. Seed matrices for ALL FOUR `IntelligenceFramework` members + codex gap filings
   are IN this build's scope; the recovery service AND the §3.3 metering surface are
   out of scope with tracked refs each.
9. Registry-entry timing: STANDARDS-REGISTRY.md entry ships in the same PR as the
   validator.
10. Retroactivity constants: `STALL_MATRIX_REQUIRED_SINCE` (minor version) +
    `STALL_MATRIX_SHIP_DATE` (ISO date); pre-ship instances
    (`createdAt < ship date`) warn until the required-since minor, then required;
    post-ship framework-onboarding instances read the requirement live from the
    canonical checklist function of (instanceType, createdAt).
11. Rollout: `apprenticeship.stallCoverageGate` in `.instar/config.json`, inline
    code default `{enabled:true, dryRun:true}`, live-read at the gate callsite,
    malformed ⇒ safe default + loud log; `/guards` load-bearing-soaking row with
    soak deadline; enforce flip operator-owned on named evidence, recorded as a
    commitment in the build PR. Cheap-to-change-after (contested and survived:
    scoped to validator message wording + warn-vs-block tuning behind the named
    dry-run flag; schema/enum/gate semantics are NOT under this tag).
12. Provisional matrix required at `pending→active` for post-ship onboarding
    instances (complete enumeration; gaps allowed).
13. Primary-class taxonomy is strictly observable-state with the §2.1 deterministic
    precedence order; causes (`host-loss`, `own-server-restart`,
    `network-partition`) are secondary tags, never rows.
14. Acceptance authority: all recorded acceptances bind to an authenticated
    principal distinct from the transition caller (dashboard-PIN /
    verified-operator); requester == acceptor is refused.
15. `REQUIRED_MATRIX_FRAMEWORKS` is derived from the `IntelligenceFramework` union
    and co-located with the class registry; onboarding a new framework extends the
    union, which extends the required set in the same PR.
16. Refusal/error hygiene: class id + rule name only; rejected raw field content is
    never echoed into 409 bodies, audit logs, or reports.
17. Ledger access (gate child process AND the live-check job): the bounded child
    reaches the commitments ledger + guards inventory via loopback HTTP to the
    local server; a stale read
    is acceptable for liveness checks (rare, human-paced operation); server
    unavailable ⇒ the non-hermetic checks refuse with a named
    "ledger-unreachable (retry)" reason — never silently skipped, never conflated
    with matrix invalidity.
18. `guardKey:` is the explicit row→guard-inventory join, REQUIRED on
    covered/covered-dark rows; manifest-exempt components use `exempt:<id>` with a
    vacuous-with-reason record; no row + no exemption ⇒ fail.
19. Aging is calendar-denominated: warning at `seededAt + 45d` (attention item), CI
    red at `seededAt + 60d`; clearing `unreviewed` requires a recorded
    `acceptanceRef` (presence/format CI-checked; authenticity at gate/live-check).
20. One acceptance artifact everywhere: {contentHash, enumerated row ids,
    authenticated principal, single-use challenge ref} via the ratify-deferral <!-- tracked: 29723 -->
    challenge mechanic; hash mismatch or challenge reuse ⇒ invalid. Binding
    granularity: row-scoped acceptances (acceptanceRef, overrides) hash exactly the
    accepted rows' canonical serialization (unrelated codemod edits do not void
    them); whole-set transition acceptances hash the whole matrix. The
    per-instance override additionally binds to the named rule/row and expires on
    any change to that row. `acceptanceRef:` charset `^[A-Za-z0-9:_-]{1,64}$`;
    acceptance artifacts (row-scoped and whole-set) live durably in
    `logs/apprenticeship-decisions.jsonl` on the gate machine (the overrides'
    store; machine-local posture as declared).
21. The codemod is offline-first (`pending-mint` + `seededAt`); the
    `stall-matrix-live-check` job (weekly, dev-agent, tier-1 supervised) owns the
    mint, the ref rewrite PR, the 45-day rung, and the recurring non-hermetic
    validation of ALL matrices; the degraded no-source rung binds to install
    provenance recorded at init (tamper-evident decisions-log append; one-time
    PostUpdateMigrator backfill for pre-existing installs), and §3.5 lands as two staged PRs (A:
    registry/validator/CI/seeds; B: gate/acceptance/live-check).

## Open questions

*(none)*
