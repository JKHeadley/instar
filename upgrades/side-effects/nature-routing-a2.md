# Side-Effects Review — Nature-Axis Routing, Increment A2.1 (dark/dryRun mechanism)

**Spec:** docs/specs/nature-axis-routing.md (status: **converged — pending operator approval**;
`review-convergence` tag, NOT `approved:true` — the operator's step). This ships as a **Tier-1**
change: the smallest independently-landable **dark** unit of FD9's Increment A2. **Parent standards:**
"Structure > Willpower", "No Silent Degradation to Brittle Fallback", benchmark-cited routing
(INSTAR-Bench v3, rules R1/R2/R8), the Maturation Path (dev-gated dark), Migration Parity.

**Files:** src/data/llmBenchCoverage.ts, src/core/IntelligenceRouter.ts, src/core/types.ts,
src/commands/server.ts, src/core/PostUpdateMigrator.ts, tests/unit/nature-routing-resolver.test.ts,
tests/unit/migrate-nature-routing-dark.test.ts, upgrades/nature-routing-a2.eli16.md,
upgrades/side-effects/nature-routing-a2.md, upgrades/next/nature-routing-a2.md.

## What changed

1. **src/data/llmBenchCoverage.ts — the DATA half.** New pure, read-only constants: `RoutingDoor`
   (CLI + metered-API door taxonomy, FD1), `CLI_ROUTING_DOORS` / `METERED_ROUTING_DOORS`,
   `ChainPosition` + `NATURE_ROUTING_DEFAULT_CHAINS` (the four v3 CLI-only chains, FD2 — metered
   positions are present but always skipped in Increment A), `ROUTING_LABEL_TO_MODEL_ID` (FD-LABEL/
   FD4.1 — benchmark-label → concrete model id), `CLAUDE_CODE_RESERVE_MODEL_ID` (the single
   sanctioned `claude-sonnet-4-6` reserve, FD4 place 1), and `NATURE_ROUTING_CRITICAL_GATES` (FD6).
   Importing this changes NO behavior — it is data actuated only when the feature is enabled.
2. **src/core/IntelligenceRouter.ts — the resolver.** New pure exports: `resolveNatureAndChain`
   (FD3 tighten rule `E,B ≥ D ≥ A`), `resolvePositionModelId` (FD4.1), `clampToReserveOnCleanDoor`
   (FD4 place-3 allowlist clamp), `resolveRoute` (the stateless fold with the four outcomes),
   `mergeNatureRoutingChains`, and the `RouterFailClosedError` typed error. Two new
   `IntelligenceRouterOptions` fields (`resolveNatureRouting`, `onNatureRoutePlan`) and a new,
   tightly-scoped block in `evaluate()` that OBSERVES when the feature is enabled.
3. **src/core/types.ts** — the `attribution.nature` opt-in tightening field (FD3) and the
   `sessions.natureRouting` config schema (type-only, NOT in ConfigDefaults, per the
   absent-equals-unchanged rule that `componentFrameworks`/`dynamicMcp` follow).
4. **src/commands/server.ts** — the construction wiring: `resolveNatureRouting` reads config LIVE
   per call and resolves `enabled` through `resolveDevAgentGate` (live-in-dryRun on a dev agent,
   dark on the fleet); `onNatureRoutePlan` is an env-gated observe-only breadcrumb.
5. **src/core/PostUpdateMigrator.ts** — `migrateConfigNatureRoutingDark` seeds `sessions.natureRouting`
   dark on existing agents (`schemaVersion:3`, `dryRun:true`, `metered.goLive:false`; `enabled`
   OMITTED for the dev-gate — the #1001 enable-path-integrity pattern), existence-checked + idempotent.

## Explicitly DEFERRED (tracked A2.2 remainder — NOT dropped)

Read this as intentional scope, not omission. This increment ships the pure mechanism + dark/dryRun
observation. The following are the ordered remainder, each a separate landable change:

- **Enforcing SELECTION** (dryRun:false actually re-routes) — A2.1 wires OBSERVATION only; flipping
  `dryRun:false` logs a one-time "enforcing not yet wired" warning and stays byte-identical (an honest
  no-op, never a silent dead switch and never a mis-route).
- **FD4 places 1 & 2** — the build-time lint (`scripts/lint-nature-chains.mjs`) and the resolve-time
  live-config validator. **Place 3 (the runtime allowlist clamp) DOES ship here** and is the actual
  runtime guarantee: it clamps every resolved claude-code FAST/SORT/JUDGE position to the sanctioned
  reserve id at selection time — so even a hand-edited chain cannot open the banned Opus-via-CLI route.
  Places 1-2 are defense-in-depth for the build + config-edit surfaces.
- **FD5b injection-exposure map** + R-rule lints (FD5c) — inert in A2.1 anyway: the only injection-
  restricted door (`groq-api`) and the R8 Flash-Lite pin are METERED doors, always skipped in Increment
  A; no CLI door in any chain is injection-restricted.
- **The durable audit** (`logs/nature-routing.jsonl`) + `GET /intelligence/routing` dryRun plan/diff/
  `?trace` read surface, the **FD6 aggregated critical-gate drift notice** + baseline, the **FD8
  Fable→Opus** migration, and the **CLAUDE.md** capability blurb.
- **Increment B** (metered-door live routing + FD12 money/PIN go-live) — DEFERRED + PIN-gated, an
  operator step, never autonomous. No metered door routes and no spend ledger is touched here.

## Blast radius

- **Byte-identical when off — THE safety case.** When `sessions.natureRouting` is absent OR
  `enabled:false` (the fleet default), the new block in `evaluate()` is skipped entirely and selection
  is bit-for-bit today's. Asserted by name: `natureRouting UNSET ⇒ selection unchanged, onNatureRoutePlan
  NEVER called` (the same options object is passed through untouched).
- **A1 is untouched.** `clampClaudeCliSwapModel` (A1's always-on degrade/swap clamp, returning the
  `balanced` TIER token) is NOT modified — the new `clampToReserveOnCleanDoor` is a SEPARATE, nature-
  routing-scoped, concrete-id clamp used only inside `resolveRoute`. Touching A1's fn would have changed
  its shipped byte-identical behavior; a test asserts A1 still returns `{model:'balanced'}`.
- **dryRun cannot mis-route.** In dryRun the resolver only computes + logs; a resolver throw
  (critical-gate fail-closed) is swallowed and recorded, never surfaced to the call path.
- **Hot path.** The observation block runs on every internal LLM call ONLY when the feature is enabled
  (dev agents). It is a stateless fold over static maps + O(1) door-reachability reads (cached by the
  provider cache); the breadcrumb log is env-gated so a dev agent's hot path stays quiet.
- **Config.** The seed is dark, existence-checked, idempotent, `enabled` omitted — it can never
  force-dark a dev agent nor clobber an operator's config.

## Second-pass review (Phase 5 — required: touches a "gate" / routing-of-safety-gates)

The change routes safety GATES, so it triggers the high-risk second pass. Independent audit focus:
(a) can the banned Opus-via-CLI route open? — No: the place-3 allowlist clamp is deny-by-default and
fires on every resolved claude-code bounded/gating position, including a hand-edited chain. (b) can a
critical gate fail OPEN? — No: the empty-set branch throws a distinct `RouterFailClosedError` for a
critical gate (never `no-route`, never legacy routing); a unit test asserts both a nature-B gate
(`MessagingToneGate`) and the nature-A R2-critical gate (`MessageSentinel`) throw. (c) is "off" truly
inert? — Yes, the byte-identical-when-off test proves it. **Reviewer verdict: Concur with the review.**
The one residual is that enforcing SELECTION is deferred — but since it is not wired, it cannot
mis-route; the runtime clamp already makes the future enforcing path safe on its own.
