# Evidence-Bar Extension — judgesClaims classification + ratchet (defect class 3, ships dark)

<!-- bump: minor -->

## What Changed

The mechanical arm of the **Evidence-Bar Extension to Judge Prompts** standard
(`docs/specs/evidence-bar-judge-extension.md`, defect class 3 / `claim-vs-evidence` closure),
shipped as a self-contained DARK increment — no runtime wiring, no operator-gated registry
amendment, no config key, no behavioral prompt change. It is the structural answer to the
2026-07-02 INSTAR-Bench v2 finding that the completion judge (and four other model routes on
the same case) credited a BARE assertion ("tests pass," no output shown) as satisfied evidence:
the agent-facing **Bug-Fix Evidence Bar** holds the CLAIMANT ("verify before you claim"), but
the prompts that JUDGE such claims were never given the same rule — an asymmetry where we hold
the claimer to a bar the judge does not know exists.

This increment ships **the judge-nature classification + its CI ratchet only**:

- The **`judgesClaims` classification** (`LLM_JUDGES_CLAIMS` in `src/data/llmBenchCoverage.ts`):
  the `judgesClaims` axis of the program's ONE shared per-callsite metadata record (sibling of
  the authority-clause `untrustedInput` axis), required-explicit for every LLM component (no
  default — a silent omission is red CI). A judge is a `{ claimKind }` entry declaring WHICH
  kind of claim it credits/refuses — `completionClaim` (proof of asserted work), `healthClaim`
  (stall/stuck/health signal sufficiency), or `scoredCredit` (rubric evaluators) — because those
  are NOT one evidence problem and their axis cases are authored per kind. Nine callsites classify
  as judges (the five measured completion/health judges — CompletionEvaluator, UnjustifiedStopGate,
  SessionWatchdog, PresenceProxy, StallTriageNurse — plus the two stall-confirm adapters and the
  two spec-named pending-wave judges JobReflector + mentor-stage-b); the deterministic real-check
  `verification_command` verifier is seed-named but is NOT an LLM callsite (it runs the actual
  command), out of the classification by construction.
- A **classification ratchet** (`tests/unit/judges-claims-classification-ratchet.test.ts`):
  required-explicit + no-dangling + valid-claimKind-per-judge + the spec-named JUDGE SEED pinned
  as a judge (the callsites measured crediting a bare claim can't silently slip out of scope) +
  the argued-false set pinned shrink-only with a real-reason floor. Same pinned-baseline family as
  `llm-bench-coverage-ratchet` and `untrusted-input-classification-ratchet`.

Deliberately OUT of scope (not orphan deferrals — see `upgrades/side-effects/`):
- The **registry amendment** (spec §1) — operator-gated; ships ONLY with Justin's explicit
  sign-off. It is DRAFTED in the spec; this run does not edit the standards registry.
- The **bench-axis pair ratchet** (spec §3: a bare-claim false-accept case + a real-evidence
  false-reject case per judge) — blocked on the SAME program-wide "batteries readable by CI"
  decision the sibling authority-clause axis ratchet deferred on (`research/` is absent from
  canonical main), owned by `class-closure-gate.md` §"Program-shared machinery" and binding all
  three axis specs.
- The **`evidenceBar()` prompt clause** (spec §4) — a sibling of the authority clause in
  `src/core/promptClauses.ts`. That shared library is introduced by the still-open sibling PR
  (authority-clause); adding the clause here would collide on the same new file. The clause is
  only consumed via the A/B-gated per-component migrations (spec §4/rollout §2), which are
  behavioral and deferred regardless. It lands as a follow-up once the shared library is on main.

## Evidence

- `npx vitest run tests/unit/judges-claims-classification-ratchet.test.ts tests/unit/llm-bench-coverage-ratchet.test.ts`
  → **2 files, 13 tests, 0 failures** (required-explicit + no-dangling + valid-claimKind + the
  JUDGE-SEED floor + shrink-only argued-false + the grounding canary; the pre-existing coverage
  ratchet still green against the additive record). During authoring the ratchet caught three
  unclassified callsites (TopicIntentArcCheck, InputClassifier, SessionSummarySentinel) and
  failed the build until they were classified — the required-explicit guard doing its job.
- `npx tsc --noEmit` → exit 0. `npm run lint` → exit 0.
- Dark-by-construction: `LLM_JUDGES_CLAIMS` is build-time metadata read only by the new pinned
  ratchet; it changes NO prompt text and wires NO runtime gate.

## What to Tell Your User

Nothing changes for you right now — this ships **dark**, and it is maintainer-only machinery (a
no-op on your install unless you develop instar itself). It records WHICH of my AI checks exist to
JUDGE a completion/health claim, so the same "a claim is not evidence — show the output" bar that
already binds what I claim can be extended to the checks that judge those claims. The judge-prompt
wording and the registry text itself change later, and only after an operator sign-off.

## Summary of New Capabilities

None active for end users in this increment — everything ships dark and additive. (For instar
maintainers: a required per-callsite `judgesClaims` classification with a shrink-only ratchet and
a pinned JUDGE-SEED floor, so a claim-judging callsite can never silently ship un-benched against
the bare-claim / real-evidence axis pair.)
