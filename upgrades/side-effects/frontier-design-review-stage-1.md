# Side-Effects Review — Frontier design and review, stage 1: the design lane and design routing at spawn

**Version / slug:** `frontier-design-review-stage-1`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (spawn lifecycle is touched)`

## Summary of the change

Build stage 1 of the approved spec `docs/specs/frontier-design-review-standard.md` (approved by Justin, topic 144319, message 144458, 2026-11-17 15:32 PST). Tier 2.

- **Registry.** `scripts/model-registry-freshness.manifest.json` gains `designLane` per door (claude-code `claude-fable-5-2`, codex-cli `gpt-6-astra`, gemini-cli `gemini-4-argon`, others `null`). `claude-fable-5-2` and `gemini-4-argon` move to `frontier: true` with notes citing the operator's messages (decision 1). The promotion note now reads "by benchmark, or by recorded operator ratification". Three `design-lane-*` pins point at the new module; the reviewer-default pin moves with its constant. The freshness lint gains a DESIGN-LANE check (a lane must be in its door's frontier set) and a drift check that a `designLane: true` pin equals the door's lane.
- **`src/core/designLane.ts`.** `DESIGN_LANE_MODELS`, `resolveDesignModel`, `isDesignLaneModel`. `CLAUDE_REVIEWER_DEFAULT_MODEL` is now defined from the Claude lane, so `/spec-converge`'s Claude reviewer reads on Fable 5.2 by default. `claude-fable-5` stays accepted as an override.
- **`src/core/designRouting.ts`.** The seven ordered steps of spec section 2, the design-work classifier (one fast-tier `gate` call, component `DesignWorkClassifier`), the account picker (plan evidence plus model-aware room), and `designStandardEnabled` over `resolveDevAgentGate` (no new setting, decision 8).
- **`src/core/designReviewLedger.ts`.** Row shape and tolerant reader of `design-review-runs.jsonl`, and the plan-evidence read. Nothing writes the file in this stage; stage 2 adds the writer route and the driver's recording mode.
- **`accountRoom`** takes an optional model: asked for a model, a non-active account has no room, and for a Fable model the per-model Fable window counts alongside the five-hour and seven-day windows. Callers that pass no model are unchanged.
- **`POST /sessions/spawn`** accepts `workKind` (`design` | `build` | `other`, else 400) and `reviewHandoff: true`, resolves design routing, launches on the lane with an account pin when one qualifies, records `workKind`, `workKindSource` and `designRouting` on the session, records `applied` plus a `launchExpectation` for a topic-bound lane launch, and writes one feature-evidence row per decision.
- **Ladder.** `src/data/feature-ladders.json` gains `frontier-design-review` (flag `developmentAgent`, `on: true`), and the spec's ladder line now names it.
- **LLM registries.** `DesignWorkClassifier` registered in `componentCategories`, the five bench-coverage maps and the provenance census (pending, by the same route as B25's card judge); the two shrink-only baselines gain the entry visibly.

Size: 8 source/data files, 3 new test files, 3 test edits. Effort: one spec round set (converged earlier, 6 rounds), commit attempts as recorded by the gate.

## Decision-point inventory

- **Is this spawn design work, when nothing was declared?** New judgment point (classifier). Floor: the only outcomes are the design model or today's model; no answer, error, rate limit or oversize brief gives `unknown` and today's model. It cannot fail or hold a spawn.
- **Which source of a spawn's model wins** — add: an ordered invariant (explicit model, remote, suppressed, kind, plan and room, lane).
- **Is the design model on this account's plan / is there room** — add: invariants over recorded evidence and stored quota windows.
- **Model-tier escalation, the mid-session swap** — pass-through, untouched.

## 1. Over-block

Nothing is blocked. Routing only chooses a model; every refusal path launches on today's model. The one way routing could have failed a spawn that works today (the second-pass reviewer's finding 1: a lane launch pinned to a pool account with no framework named, which the session manager refuses) is closed twice: a pinned launch always names its framework, and if the session manager still refuses the pin the route launches once more exactly as today, records the session `lane-refused`, and writes a `lane-pin-refused` error row. A 400 is returned only for an invalid `workKind` or a `reviewHandoff` that is not `true`; neither field existed before, so no existing caller sends them.

## 2. Under-block

- A design brief the classifier reads as `other` runs on today's model (recorded `not-design`, source `classified`). Accepted by the spec; graded at each rung by the agreement metric.
- Until stage 2 writes ledger rows, no account has plan evidence, so on a real agent every design spawn records `lane-refused: not-confirmed` and runs on today's model. That is the spec's stated first-design behaviour; the lane starts working with the first recorded review.
- A login that lost the design model after its last confirming review can be launched on it once (spec, Under-block). The next review run records the refusal.
- Remote spawns, `POST /sessions/create`, jobs and running conversation sessions are not routed (decision 13); caught at the approval point in stage 3.

## 3. Level-of-abstraction fit

Routing sits in the spawn route, the one place where a direct spawn's model is chosen, next to the existing topic-profile resolution it outranks. The decision logic is a pure module the route calls, so the route keeps only wiring. The classifier goes through the shared intelligence funnel, not a private client. The lane is a registry pin under the existing freshness lint rather than a config value.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`.

The change holds no blocking authority. The classifier's answer, the ledger rows and the quota windows are signals that choose between two models; the worst wrong answer is a session on the other model. No brittle check gates anything.

## 4b. Judgment-point check

The one competing-signals point (is this brief design work?) is a judgment by an LLM inside a floor, not a keyword heuristic. The other points are invariants listed in the spec's decision table with their basis.

## 5. Interactions

- **Topic profile orchestrator.** A lane launch on a pinned topic records `applied` and a `launchExpectation` equal to what launched, so the boot sweep and tick do not respawn it (integration and e2e tests prove it). The expectation is pin-revision bound by the orchestrator, so a later pin change still applies.
- **Model-tier escalation.** Not read or written; `models.tierEscalation` untouched.
- **Account pinning.** Uses the existing `accountPin` option, only for Claude and Codex (the only frameworks it accepts); the pinned launch names its framework, and a refused pin retries once unpinned on today's model. Default-login evidence counts only where no pool account serves the door, because with pool accounts present an unpinned launch is placed by the pool's own resolver, which could pick an account with no evidence or no room (reviewer finding 2).
- **`/spec-converge` Claude reviewer.** Its default moves from `claude-fable-5` to `claude-fable-5-2` for every agent (approved, decision 1 and section 1). The Claude reviewer family is itself dark on the fleet unless enabled, so the change reaches development agents and agents that enabled it. Until stage 2 adds the one fallback to the door's default model (decision 12), an agent whose plan lacks Fable 5.2 gets a degraded (loudly reported) Claude pass rather than a silent one. An explicit `claude-fable-5` override keeps working.
- **spawnLimiter.** The classifier call runs inside the existing limiter, so a burst cannot fan out calls.

## 6. External surfaces

- The spawn route's request gains two optional fields; its response carries the session record, which gains three optional fields. A remote spawn's 202 body may carry `designRouting`.
- The registry manifest changes (two promotions, a new field). The freshness lint is strict and passes.
- Users see nothing. Echo's design sessions run on Fable 5.2 once a review confirms the account.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Design lane: unified**, compiled from the git-tracked registry.
- **On/off:** follows `developmentAgent` per machine until graduation (existing config, not introduced here).
- **Plan evidence and room: machine-local by design** — machine-local-justification: physical-credential-locality; an account is a login on this disk, so only this machine's ledger rows (stamped with the mesh id, `local` on a single machine) are read.
- **Remote spawns: not routed** (decision 13), recorded `remote-not-routed`.
- **Status surfaces:** none added. Evidence rows go to the existing per-machine `logs/feature-evidence.jsonl`, read by the maturation review per machine.

## 8. Rollback cost

A release that removes the route call (or a code default of off) restores today's behaviour; nothing persists except optional fields on session records and evidence rows, both inert. The manifest promotions are a reviewed registry edit, reverted by the same.

## Conclusion

Stage 1 lands the lane and the routing step with every refusal path falling back to today's model. It is gated to development agents by the existing gate and measured through the ladder entry. Stages 2 to 4 (ledger writer and driver mode, B26, awareness and migrations) follow on their own PRs.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (Claude Opus 5.5), read-only over the diff and the spec

**Independent read of the artifact: concur** (after two rounds of concerns, each resolved as recorded below; final read: "Concur with the review").

Round 1 raised four points:
1. HIGH: a design spawn pinned to a pool account with no framework in the request would throw `account-pin-framework-unsupported` (SessionManager pin validation), failing a spawn that works today. Fixed: the pinned launch names its framework; a refused pin retries once unpinned; integration test `a pinned launch names its framework, and a refused pin falls back`.
2. MEDIUM: default-login evidence was used while a pool existed, so an unpinned launch could land on an unconfirmed or walled account. Fixed in `chooseLaneAccount`; unit test added.
3. LOW-MEDIUM: the two new lint checks had no tests, and the reviewer-pin non-vacuity fixture still pointed at the old site. Fixed: `tests/unit/model-registry-design-lane.test.ts` (5 cases) and the fixture now targets `designLane.ts`.
4. LOW: artifact wording (sections 1 and 5) and the fleet reach of the reviewer default. Fixed above.

Round 2 raised one low-severity point: after a refused pin the fallback relaunch still recorded the design model as the topic's applied launch, so the profile orchestrator would start from a false value. Fixed: a `laneFellBack` flag sends the fallback down the existing topic-profile record path; the integration case now runs on a pinned topic and asserts the pin is launched and recorded.

Checked and fine by the reviewer: the seven-step order, classifier only at step 5, the topic-profile expectation (no respawn, a later pin change still applies), Gemini never pinned, `accountRoom` callers unchanged.

## Evidence pointers

- Unit: `tests/unit/model-registry-design-lane.test.ts`; `tests/unit/designRouting.test.ts` (36 cases: every step of the order, the classifier contract and boundary, model-aware room, account choice, ledger torn line, plan evidence); `tests/unit/crossModelReviewer-clean-door.test.ts` (default now the lane); registry ratchets.
- Integration: `tests/integration/sessions-spawn-design-routing.test.ts`.
- E2E: `tests/e2e/design-routing-spawn-lifecycle.test.ts`.
- Lint: `node scripts/lint-model-registry-freshness.mjs` PASS with the design-lane checks.
- Live proof on a throwaway agent (2026-11-17, M5, branch build, real Claude classifier, real headless sessions): declared design → `design-lane` on `claude-fable-5-2`; undeclared design brief → classified `design`, `design-lane`; build brief and mixed design-and-build brief → classified `other`, `not-design`, today's model; suppressed topic → `suppressed`; pinned topic (Opus 5.5) design → `design-lane` on `claude-fable-5-2`; explicit `sonnet` → `explicit-model`; remote target → 409 carrying `remote-not-routed`; no confirming review → `lane-refused: not-confirmed`. Plan evidence for this stage was a hand-seeded ledger row (the first run also showed a row stamped with another machine's id is correctly ignored); stage 2 proves the evidence written by real review runs, the no-room pool and the plan-refusal cases.

## Class-Closure Declaration (display-only mirror)

- **unbounded-self-action — closure: n/a.** One-shot user-driven action, not a self-triggered loop: the only added spawn is a single unpinned retry inside the caller's request when the session manager refuses the design-lane account pin. It runs at most once per `POST /sessions/spawn`, behind the route's existing `spawnLimiter`. The machine-readable declaration is in this commit's trace.
