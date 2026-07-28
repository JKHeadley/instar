# Side-Effects Review — june15-headless-spawn-reroute (PR 2)

Spec: `docs/specs/june15-headless-spawn-reroute.md` (converged, 5-reviewer
panel, approved by Justin in topic 9984 2026-06-05: "you have my approval if
needed. please continue!").

## Behavior changes when `mode` is `off`/unset (the fleet default)

NONE intended, and pinned: V1/V5 argv pin tests assert the headless launch
argv is byte-for-byte unchanged at every touched callsite for claude-code,
codex-cli, and gemini-cli. Admission behavior of SpawnRequestManager and
PipeSessionSpawner is unchanged (the quota/mode seams are absent unless the
server wires them, and the server only wires them when mode is auto/force).
Two deliberate always-on deltas, both additive:

1. **`Session.launchLane` is now always stamped** (`'headless'` on the
   default lane) and serialized via the existing `{ ...s }` spreads in
   `GET /sessions` + the reap-log. Consumers that enumerate fields see one
   more key. No existing field changes meaning.
2. **`rawInject` strips bracketed-paste boundary sequences**
   (`\x1b[200~` / `\x1b[201~`) from injected text (finding S2). Legitimate
   prompts never contain raw paste-boundary bytes; anything that did was a
   forged-submit vector, not a feature.
3. **Three server.ts intelligence FALLBACK sites** (shared, relationships,
   topic-summarizer) now construct via `buildIntelligenceProvider` instead
   of `new ClaudeCliIntelligenceProvider` directly. When the factory returns
   null (no claude binary), the fallback is now an honest absence instead of
   a provider with an undefined binary path that fails at call time — a
   strict improvement on an already-degraded path.

## New failure modes introduced (and their bounds)

- **Rerouted session never prints the sentinel** → reaped at
  `maxLifetimeMinutes` (default 45) as timeout + DegradationReporter event.
  Bound: the lifetime cap; tested.
- **Reroute silently dead under `auto`** (cap stuck / pressure stuck /
  continuity gap) → every spawn falls back headless; the F6 recurrence cap
  raises ONE escalated degradation event per 30-min window instead of
  letting the self-heal hide it.
- **Restart with a rerouted job mid-flight** → boot reconciliation kills the
  surviving REPL (job reruns cleanly); per-slug guard prevents concurrent
  double-execution. Tested both.
- **Force-mode refusal paths** (cap/memory/pipe) are loud: throw or
  `{spawned:false}` + degradation event — never a silent drop. The pipe
  refusal shape (`{spawned:false}` from inside `spawn()`) is pinned by test
  because only that shape falls through to the rerouted A2A path.

## Quota / cost surface

- Rerouted spawns bill the subscription 5h window. Bounds: `maxRerouted`
  (default 3) + memory-pressure pre-spawn gate + QuotaTracker backpressure
  on A2A/pipe admission (the same gate scheduled jobs already use). The
  worst case (window already ≥95%) denies non-critical spawns BEFORE they
  land on the window.
- The `auto` decision reuses PR 1's TTL-cached credit reader via
  `setSdkCreditReader` — one credit source for both routing layers, no
  drift.

## Framework generality (launch/inject surface)

The reroute is **claude-code-only by design** — it exists to dodge
Anthropic's June-15 SDK-pot billing; codex-cli and gemini-cli headless
spawns are untouched on every mode (V5 pin test). The launch builders are
not modified; the reroute composes `buildInteractiveLaunch` +
`claudeHeadlessExtraFlags`, both existing per-framework abstractions. Works
for codex-cli/gemini-cli: yes — by explicit non-interference, pinned by
test. The funnel lint allowlist names the two legitimate
`buildHeadlessLaunch` callsites; a future framework adding a third must
justify it at review.

## Migration / fleet rollout

- New config keys are optional with safe defaults; `migrateConfig` additions
  are not needed (absence = off).
- CLAUDE.md template block corrected + a NEW idempotent migration
  (`headless job / agent-to-agent / dispatch spawns` sniff) patches the
  already-deployed PR-1 wording on update — both PR-1 wordings ("routes
  them" / "can route them") handled; hand-edited sections left untouched.
  Tested (5 cases incl. idempotency).

## Evidence pointers

- Unit: `tests/unit/headless-spawn-reroute.test.ts` (23),
  `tests/unit/subscription-quota-gates.test.ts` (8),
  `tests/unit/lint-no-unfunneled-headless-launch.test.ts` (4),
  `tests/unit/PostUpdateMigrator-subscriptionPathScope.test.ts` (5),
  `tests/unit/job-scheduler-double-run-guard.test.ts` (3)
- Integration: `tests/integration/sessions-launch-lane.test.ts` (1)
- E2E: `tests/e2e/june15-headless-spawn-reroute.test.ts` (4 —
  production-mirroring construction, the spawn-path "200 not 503")
- Spec + ELI16: `docs/specs/june15-headless-spawn-reroute.md` / `.eli16.md`
- Lint: `scripts/lint-no-unfunneled-headless-launch.js` (chained in
  `pnpm lint`)

## CI-green follow-up #2 (Zero-Failure Standard)

A main-drift imbalance surfaced by this PR's CI (route-completeness:
225 `catch (err)` vs 224 `err instanceof Error` in routes.ts — landed on
main via a [skip ci] merge that never ran this shard). Per the Zero-Failure
Standard ("no pre-existing failures — if you see it you own it"), fixed by
converting one `/providers/...` route's `(err as Error).message` cast to the
safe `err instanceof Error ? err.message : String(err)` guard — balances the
count AND is strictly safer (an `as Error` cast lies if err isn't an Error).
Also: the codex-model-swap structure-pin window widened past the reroute
branch (test-only — invariant unchanged).
