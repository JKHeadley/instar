# Side-Effects Review — framework-stall-coverage-matrix PR-A

**Change:** PR-A of the framework-stall-coverage-matrix standard (spec:
`docs/specs/framework-stall-coverage-matrix.md`, converged 2026-07-18, approved by
Justin 2026-07-18 10:29 PDT, topic 29723). Ships: the canonical class registry
(`src/data/stall-classes.ts`), the matrix validator module, the CI ratchet test in the
whole-tree push suite, the offline-first class-registry codemod
(`scripts/stall-class-codemod.mjs`), seed matrices for all four
`IntelligenceFramework` members (`docs/frameworks/*-stall-coverage.md`), evidence
tests for claude-code covered rows, and the STANDARDS-REGISTRY.md entry. PR-B
(runtime gate wiring, acceptance/override machinery, `stall-matrix-live-check` job)
is the second staged PR per the spec's staged-landing plan — tracked by the spec
itself, not an ambient deferral.

## Phase 1 principle check (recorded)

Does this change involve a decision point? **Partially — and deliberately only the
invariant half.** The validator performs structural validation exclusively:
front-matter parse, status-token legality, class-list completeness, symbol/evidence
existence + containment, charset/format checks, calendar aging arithmetic. The spec's
own "Decision points touched" table classifies these as `invariant`, and
`docs/signal-vs-authority.md` explicitly exempts hard-invariant validation at the
system boundary from the signal-vs-authority pattern. Every judgment call the
standard contains — whether a `covered` claim is TRUE, acceptance of declared
gaps/N-A reasons, class minting — is routed to a human authority (overseer /
dashboard-PIN acceptance) by the spec, and NONE of that machinery ships in PR-A. The
validator emits per-row `mechanically-verified: presence-only` so no downstream
surface can present `covered` as proven.

## 1. Over-block

The CI ratchet fails pushes when a matrix is missing, malformed, incomplete, or
carries dead symbols/evidence. Legitimate inputs it could wrongly reject:

- A refactor renaming a detector symbol reds the matrices citing it. This is BY
  DESIGN (matrices cannot rot), and the fix is one line in the matrix in the same
  PR. Named in the failure message.
- A test file moved out of the push suite's effective collected set invalidates
  evidence citing it — also by design (evidence no runner executes proves nothing).
- Future-dated `seededAt` is rejected — cannot stall the aging clock. A machine with
  a badly skewed clock could reject a legitimately-seeded same-day row; bounded by
  using date-only granularity (UTC) and accepting `seededAt <= today`.
- Mitigation for all: failure messages name the class id + rule; the ratchet
  test's assertion message names the one-command fix (run the codemod) for the
  class-growth case and "update the named matrix row" otherwise. No runtime
  behavior is gated in PR-A, so an over-block costs a red push, never a
  degraded agent.

## 2. Under-block

- CI is hermetic by design: issueRef/closePath LIVENESS and posture/guards
  cross-checks are NOT validated at CI (format only) — they belong to the PR-B gate
  callsite and live-check job. Until PR-B lands, a dead closePath ref is invisible
  to enforcement. Accepted, tracked by the staged-landing plan (PR-B is next in the
  same drive session).
- The validator checks symbol PRESENCE (file exists + identifier appears), not
  semantic truth of `covered` — by explicit spec design (the mind judges truth; the
  gate report enumeration ships in PR-B).
- Evidence containment checks are static (identifier + marker + raw-signature
  presence, effective-collection membership) — a maliciously-labeled test could
  carry the markers without asserting anything. The §5 evidence tests shipped here
  are genuine positive-controls; the static check is the structural floor, the
  review is the judgment layer.

## 3. Level-of-abstraction fit

Right layer. The class registry is data (`src/data/`), mirroring how other canonical
lists ship. The validator is a standalone module with two planned callsites (CI now,
gate in PR-B) rather than logic embedded in either — exactly the spec's "one
validator, two callsites" design. The codemod is a script, not server runtime — the
sweep/server must never mutate the checked-out tree (SourceTreeGuard posture).

## 4. Signal vs authority compliance

Compliant. The CI ratchet is a brittle blocker over structural facts — the exempted
category (hard-invariant validation; same family as "this field must be a number").
It makes no judgment about meaning or intent. The judgment decision points are
explicitly deferred to human authorities via PR-B's acceptance machinery, and PR-A
ships no blocking surface that evaluates content semantics. No new brittle authority
over message flow, sessions, or agent behavior is introduced.

## 5. Interactions

- The ratchet test joins the whole-tree push suite (`vitest.push.config.ts`); it
  does not shadow or race any existing check. It shares the conformance-audit
  symbol-check MECHANIC (file exists + identifier appears) but reads different
  artifacts (matrix front-matter vs standards registry) — no double-fire.
- The codemod writes matrix files only; it never touches the registry or other
  docs. Idempotent re-runs are no-ops (verified by unit test).
- Framework-issue filings + closePath commitments created by this build ride
  existing ledgers (idempotent dedupKeys; commitment anchors CMT-890 (codex
  gaps), CMT-891 (pi gaps), CMT-892 (claude mid-turn-interrupt), CMT-893
  (covered-dark autoRecovery flip)). No new notification surface — nothing
  here messages users.

## 6. External surfaces

- New repo artifacts only (docs, src/data, scripts, tests). No API route, no config
  key, no message to any user, no behavior change for deployed agents in PR-A. The
  npm package ships the new module inertly; nothing imports it at runtime yet
  (first runtime consumer is PR-B's gate).
- No timing/conversation-state dependence. CI runtime cost: one additional test
  file parsing four small matrices — negligible.

## 7. Multi-machine posture

Matrix artifacts + registry + validator are **unified-via-git** (repo-tracked
files; every machine sees the same content at the same SHA — the spec's declared
posture). The build-run side artifacts (framework-issues, commitments) live on the
development agent's machine — consistent with the apprenticeship registry's
declared machine-local posture, and the spec's §Multi-machine section names this
(closePath refs resolve on the gate machine, in PR-B). No stranding risk: PR-A
creates no per-machine runtime state.

## 8. Rollback cost

Revert the PR. Matrices/registry/validator/codemod are inert without the PR-B gate;
the CI ratchet disappears with the revert. No data migration, no agent state, no
config. The filed framework-issues and closePath commitments remain as tracked
records (harmless, and still true — the gaps exist whether or not the standard
ships). Cheapest possible rollback class.

## Second-pass review

Required? The change contains the words "gate"/"sentinel" only in docs; PR-A wires
no session-lifecycle, messaging, or dispatch behavior. HOWEVER — the CI ratchet
blocks pushes repo-wide, which is a block/allow decision on the development
pipeline, and the standard is safety-relevant. **Second-pass review: YES** (called
below).

### Second-pass reviewer response

**Concern raised (2026-07-18):** the artifact's Phase-1 claim "the validator
emits per-row `mechanically-verified: presence-only`" was contradicted by the
shipped code — the marker existed in the spec but not in `StallMatrixResult`,
and the safety-argument property could have silently never landed. Secondary:
the over-block mitigation overstated the failure messages ("one-command fix"
was not actually in any output). Everything else verified: refusal hygiene
holds, validator genuinely hermetic, ratchet is the sole (push-time) blocking
surface, PR-A/PR-B split matches the spec, signal-vs-authority argument sound
under the hard-invariant exemption.

**Resolution (same session, before commit):** (1) `StallMatrixResult.rows`
added — one `{classId, status, mechanicallyVerified: 'presence-only'}` record
per canonical row, asserted by the ratchet test on every matrix; (2) the
ratchet's assertion message now names the codemod one-command fix for the
class-growth case; (3) this artifact's over-block wording corrected to match
the real output. Reviewer's non-blocking observations (basename echo on
direct-call misuse; conservative substring aging match) accepted as noted —
both fail in the safe direction.

**Post-resolution status: concerns resolved; review concurs with the
artifact as amended.**
