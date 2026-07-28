# Side-Effects Review — Dev-Agent Dark-Gate Teeth (CMT-1438)

**Version / slug:** `dev-agent-dark-gate-teeth`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `required (touches gate/sentinel/migration) — see below`

## Summary of the change

Retires the catch-all `deliberate-fleet-default` category from the `DarkGateCategory`
enum and adds a concrete `action-bearing` category, so every "off even on dev"
classification must name a real reason dev-live is wrong (unsafe: destructive /
cost-bearing / action-bearing; or not-runnable: optional-integration /
structural-stub). Tightens the CI lint (`scripts/lint-dev-agent-dark-gate.js` +
`scripts/lib/dark-gate-attribution.js`) to reject the retired category and adds a
count-match guard that fails loud when an exclusion entry escapes category validation
(the backtick-reason silent-skip hole). Reclassifies the 11 occupants: after per-feature
D4 code-grounding, 4 move to `DEV_GATED_FEATURES` (parallelWorkSentinel, failureLearning,
releaseReadiness, bootHealthBeacon) — their construction sites now route through
`resolveDevAgentGate` and their `enabled: false` literal is removed from ConfigDefaults;
7 stay exclusions with concrete categories (correctionLearning=cost-bearing,
apprenticeshipCycleSla/geminiCapacityEscalation/greenPrAutoMerge/a2aCheckIn=action-bearing,
mentor/mentee=optional-integration). Adds `PostUpdateMigrator.migrateDevGateTeethStrip` —
a one-shot, dev-agent-only strip of stale persisted `enabled: false` for the 4 paths so
the move actually lands on existing dev agents.
Files: `src/core/devGatedFeatures.ts`, `scripts/lib/dark-gate-attribution.js`,
`scripts/lint-dev-agent-dark-gate.js`, `src/config/ConfigDefaults.ts`,
`src/server/AgentServer.ts` (parallelWorkSentinel + failureLearning gates),
`src/commands/server.ts` (releaseReadiness + bootHealthBeacon gates),
`src/server/CapabilityIndex.ts` (failureLearning capability report),
`src/core/PostUpdateMigrator.ts` (D5 migration) + 3 test files.

## Decision-point inventory

- `DarkGateCategory` enum (classification taxonomy) — **modify** — drop the catch-all, add `action-bearing`; closes the willpower escape hatch.
- `lint-dev-agent-dark-gate.js` Assertion C (CI gate) — **modify** — the closed-enum membership check tightens (one fewer valid category) + a count-match guard added.
- `resolveDevAgentGate` at 4 construction sites — **modify (pass-through to the funnel)** — the 4 features' enable check now goes through the existing dev-gate funnel instead of a hand-rolled `=== true`. No new decision logic; it reuses the established resolver.
- `migrateDevGateTeethStrip` — **add** — a config-mutation migration (deletes a stale `enabled: false`), dev-agent-only, run-once. Not an information-flow gate.

---

## 1. Over-block

No outbound/inbound message block surface. The only "block"-shaped surface is the CI
lint, which now *rejects* (a) an exclusion using the retired `deliberate-fleet-default`
category and (b) an exclusion entry that doesn't fully parse (count-mismatch). The
count-match guard can *over-trip* on a legitimate-but-unparseable entry — specifically
an exclusion `reason` written with embedded quotes or a backtick/template literal. This
is intentional fail-safe behavior (it forces a parseable, single-line, quote-delimited
reason); it never lets a bad entry through. It surfaced exactly once during this build
(my own reasons contained embedded `"`), was loud, and was fixed by rewording — proving
the guard works. Authoring constraint, not a runtime over-block.

---

## 2. Under-block

The lint still matches the literal `enabled: false` spelling only (a pre-existing,
documented limitation — a non-literal `enabled: someFlag ?? false` evades attribution).
The count-match guard closes the parsed-path-without-a-parsed-entry class (backtick
reasons, reordered fields) but the registry parser remains regex-based, so other
source-shape shifts (object spread, imported constants, `as const`) are still a
theoretical blind spot — disclosed in the spec and tracked as a follow-up (AST /
pure-data registry). The category honesty itself is never machine-checked (the lint
validates spelling + reason length, not truthfulness); D4 code-grounding + the
GrowthMilestoneAnalyst R6 runtime cross-check are the backstops, also disclosed.

---

## 3. Level-of-abstraction fit

Right layer. The change does NOT add a new detector or authority — it (a) edits a
classification enum + its CI lint (build-time signal), and (b) routes 4 features through
the EXISTING `resolveDevAgentGate` funnel rather than re-implementing the gate inline
(it removes 4 hand-rolled `=== true` checks). The migration reuses the EXISTING
`migrateCartographerDevGate` pattern (same `_instar_migrations` marker machinery, same
dev-agent guard). Nothing is re-implemented; everything feeds or reuses an existing
primitive.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate / has no
  runtime block-allow surface.

The CI lint is a deterministic build-time *signal-emitter* (it fails CI on an invalid
classification); it is not a runtime authority over agent behavior. The spec is explicit
that the lint closes only the *unclassified/invalid-category* hole — it does NOT
adjudicate category *honesty* (that is D4 + R6). `resolveDevAgentGate` is the established
funnel, not a new brittle authority. No brittle blocking authority is added.

---

## 5. Interactions

- **Shadowing:** the 4 construction-site gate calls replace `=== true` with
  `resolveDevAgentGate(...)`. For 3 of the 4, routes/consumers already gate on the
  *constructed instance* (null → 503), so they follow the gate result with no shadowing.
  For `failureLearning`, `CapabilityIndex` also reads the flag — updated to the SAME
  funnel so the capability report matches the construction gate (no skew).
- **Double-fire:** `migrateDevGateTeethStrip` shares the `_instar_migrations` ledger
  with `migrateCartographerDevGate`; the new marker key (`dev-gate-teeth-strip`) is
  distinct (not a prefix of, nor prefixed by, `cartographer-dev-gate-strip`), so the two
  run independently and each exactly once. Verified by the round-2 integration review.
- **Races:** the migration runs in the single-threaded PostUpdateMigrator pass at update
  time; no concurrent writer to config.json during it.
- **Feedback loops:** none. The lint is one-way (CI fails or passes).

---

## 6. External surfaces

- **Other agents on the machine:** none — the change is per-agent config + a CI lint.
- **Install base:** fleet behavior is byte-for-byte unchanged (every reclassified flag
  still resolves `false` on a non-development agent; the migration is dev-agent-only).
  Only development agents gain the 4 live observers.
- **External systems (Telegram/GitHub/etc.):** the 4 features moved live are
  D4-verified to make NO automatic outbound send on enable (parallelWorkSentinel: local
  event/JSONL; failureLearning: append-only ledger, send path unimplemented;
  releaseReadiness: read surface only, sends gated behind the separate dark job;
  bootHealthBeacon: localhost-only inbound socket). The 3 features that DO auto-send
  (correctionLearning spend; apprenticeshipCycleSla/geminiCapacityEscalation Telegram)
  were deliberately HELD as exclusions precisely to avoid that surface on dev.
- **Persistent state:** the migration deletes a stale `enabled: false` key from the dev
  agent's own `config.json` (and records a run-once marker). Reported in the migration
  result summary so a non-Echo operator sees which flags were freed.
- **Operator surface (Mobile-Complete):** no operator-facing actions added — no route, no
  form, no PIN-gated action. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — this change touches no dashboard renderer/markup, approval page, or
grant/revoke/secret-drop form. Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The dev-feature classification is a code-shipped TypeScript
enum + `ConfigDefaults` + each agent's per-machine `.instar/config.json`; `developmentAgent`
is intrinsically a per-machine identity. None of the `multiMachine.stateSync.*` replicated
kinds cover config flags or dev-gate state, and nothing here should follow the agent across
machines — a machine either is or isn't a development agent. The D5 migration is
dev-agent-only and mutates only the local config.json. No user-facing notice is emitted by
this change (the 4 live features that COULD notify are either send-inert on enable or held
as exclusions). No durable cross-machine state, no generated URLs. Confirmed by the
round-1 integration reviewer (no journal kind needed).

---

## 8. Rollback cost

Pure code + config-default change. Back-out = revert the commit (re-adds the
`deliberate-fleet-default` enum member, the 4 `enabled: false` literals, the 4
construction-site `=== true` checks, and removes the migration) and ship a patch. The D5
migration is idempotent and run-once; a rolled-back agent that already ran it keeps its
stripped config (the 4 flags then resolve via the reverted hardcoded `false` again — back
to dark — with no error). No data migration, no agent state repair, no user-visible
regression during the rollback window (fleet was never changed). An operator who wants a
freed flag off again simply re-adds `enabled: false` (the run-once marker preserves it).

---

## Conclusion

This review (plus the 6-round spec convergence that preceded it) reshaped the change in
three material ways: (1) the migration was added after convergence found the 4 flags
would otherwise stay dark on Echo (the cartographer trap); (2) D4 code-grounding held 3
of 7 candidates back as honest exclusions when their code contradicted "observe-only";
(3) the count-match lint guard was added after the adversarial reviewer found the
backtick-reason silent-skip. The change adds no runtime blocking authority, makes no
automatic external send on the dev agent (the senders are held off), leaves the fleet
byte-for-byte unchanged, and is cleanly reversible. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Concur with the review. The reviewer grounded every claim against the actual diff and confirmed: (1) all 4 construction sites route through `resolveDevAgentGate` with no hand-rolled `?? !!developmentAgent` (AgentServer.ts:858/1238, server.ts:3041/13258, CapabilityIndex.ts:794); (2) the migration allowlist is EXACTLY the 4 dev-gated paths, dev-agent-guarded, with a run-once marker distinct from cartographer's; (3) the signal-vs-authority answer holds (build-time signal + reused funnel + fail-safe count-match guard, no new blocking authority); (4) the highest-risk check — a missed read site — was investigated: the 4 flags also feed `src/monitoring/guardManifest.ts` → the `/guards` posture endpoint, but `guardPosture.ts:resolveGuardConfigSnapshot` already iterates `DEV_GATED_FEATURES` and injects the gate-resolved value, so moving the 4 into the registry makes `/guards` resolve them live on a dev agent automatically — NO "live-but-reported-disabled" skew, and the now-absent default raises no spurious boot tripwire. The reviewer's one non-blocking nit (stale "ships dark" prose in 4 `guardManifest.ts` descriptions) was fixed in this commit (descriptions now say "(dev-gated)"). Clear to ship.

---

## Evidence pointers

- Spec + convergence report: `docs/specs/DEV-AGENT-DARK-GATE-TEETH-SPEC.md`,
  `docs/specs/reports/dev-agent-dark-gate-teeth-convergence.md` (6 rounds, real
  cross-model pass codex-cli:gpt-5.5).
- Tests: `tests/unit/lint-dev-agent-dark-gate.test.ts` (enum/category/count-match +
  drift canary), `tests/unit/devGatedFeatures-wiring.test.ts` (42 tests — 4 new entries
  resolve live-on-dev/dark-on-fleet), `tests/unit/PostUpdateMigrator-devGateTeethStrip.test.ts`
  (7 tests — migration both sides + idempotency + the 3 held), `tests/integration/dev-gate-teeth-rollout.test.ts`
  (5 tests — full migration→defaults→resolver pipeline + two-switch drift guard).
- D4 grounding evidence (file:line) is in the spec's "D4 grounding result" section.
