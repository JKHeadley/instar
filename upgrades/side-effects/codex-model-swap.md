# Side-Effects Review — Codex rate-limit model-swap (directive #4b)

**Version / slug:** `codex-model-swap`
**Date:** 2026-05-30
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** REQUIRED (touches session spawn / lifecycle) — see verdict at end

## Summary of the change

At codex session launch, if the agent's main model has exhausted its weekly
window, launch the next session on a configured fallback model (separate quota
bucket) instead of stalling. New pure policy
(`src/providers/adapters/openai-codex/observability/codexModelSwapPolicy.ts`) +
a private `SessionManager.resolveCodexLaunchModel` helper wired into BOTH codex
launch paths (`spawnSession`→`buildHeadlessLaunch`,
`spawnInteractiveSession`→`buildInteractiveLaunch`). Consumes the on-disk
`readLatestCodexUsage` reader (shipped in CODEX-USAGE-VISIBILITY). Ships DARK
behind `config.codex.rateLimitModelSwap.{enabled,fallbackModel,weeklyRemainingThreshold}`.

## Decision-point inventory

- `SessionManager.resolveCodexLaunchModel` (NEW decision) — picks the launch
  model for a codex spawn. Add. It is a model SELECTION, not a block/allow gate:
  the only outcomes are "requested model" or "configured fallback model". Both
  spawn paths consume it (pass-through for non-codex / disabled).

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The policy never rejects
or cancels a launch. Its worst "wrong" outcome is launching on the fallback
model when it didn't strictly need to (e.g. weekly at exactly the threshold) —
which still produces a working session, just on the other quota bucket.

## 2. Under-block

**Not a blocker.** The closest "miss": the swap only takes effect at the NEXT
launch — a session already mid-turn on an exhausted model still fails that turn
(it can't change model mid-flight). That is inherent to how model selection
works and is the correct scope; the RateLimitSentinel covers the in-flight
throttle messaging separately. Also: if usage can't be read, no swap happens
(fail-safe) — a genuinely-exhausted agent with an unreadable rollout would not
swap. Acceptable: it degrades to today's behavior (launch on the main model).

## 3. Level-of-abstraction fit

Right layer. The decision lives in the openai-codex observability namespace
(beside the reader it consumes) as a pure function; the WIRING lives in
SessionManager at the single point where the launch model is finalized for each
spawn path. It does not belong in the reader (that's a pure read surface) nor in
a separate poller (a poller would have to persist an override and re-apply it —
more state, more drift; deciding at launch is stateless and exact).

## 4. Signal vs authority compliance

**Compliant.** Pure signal-driven decision, zero blocking authority (ref
`docs/signal-vs-authority.md`). It consumes the authoritative usage signal and
selects a model. No brittle gate, no veto. Fails safe (read failure → requested
model). The signal producer (the reader) and this consumer are cleanly split.

## 5. Interactions

- **Shadowing / double-fire:** none. It's the only thing that selects the codex
  launch model; it runs once per spawn. The two call sites are mutually
  exclusive (headless vs interactive spawn of a given session).
- **RateLimitSentinel:** complementary, not conflicting. The sentinel handles an
  IN-FLIGHT throttle (backoff + notify + verify recovery); this picks the model
  for the NEXT launch. They operate at different moments and don't race.
- **`/local-model` + `frameworkDefaultModels`:** the swap takes `options.model`
  / `defaultModel` (already resolved from those) as its INPUT and only overrides
  when armed + exhausted, so an explicit per-call/local model still flows through
  untouched when the feature is off (default) or the window is healthy.
- **Shared `~/.codex/config.toml`:** unaffected — the model flows via the launch
  flag (`-c model=` / `--model`), the per-spawn override that already wins over
  the shared config (same mechanism as `codexThreadlineMcpFlags`). No multi-agent
  config collision.
- **Spawn-path latency:** when DISABLED (default) the fast-path guards return
  before any disk read — zero added latency. When enabled, the read is the same
  bounded path the shipped `/codex/usage` route uses: a recursive walk of
  `$CODEX_HOME/sessions` (`listAllRollouts`, capped to the newest few) plus a
  tail-read of the newest rollout. All async fs, wrapped best-effort (never
  throws, never blocks the spawn). Only runs when the feature is armed.

## 6. External surfaces

- **Behavioral, opt-in:** when an operator enables it with a verified
  `fallbackModel`, a codex session may launch on a different model than the
  configured default once the weekly window is low. That is the intended,
  operator-armed behavior. A `[SessionManager]` log line records every swap with
  the reason.
- No new HTTP surface, no new message, no change visible to other agents.
- Off by default → no change for any existing agent on update.

## 7. Rollback cost

Low. Pure additive + dark. Back-out = revert the policy module + the
SessionManager helper/wiring + tests; no data migration, no agent-state repair.
In the field, neutralise instantly by not setting (or removing)
`codex.rateLimitModelSwap.enabled` — no redeploy of code required.

---

## Phase 5 — Second-pass reviewer verdict

**Concur with the review.** An independent reviewer subagent audited this artifact
AND the actual code (not just the claims), verifying each risk with file:line
citations:

- **Never blocks/delays/breaks a launch:** the single new
  `await this.resolveCodexLaunchModel(...)` on each spawn path delegates to
  `resolveCodexLaunchModelWithUsage`, whose disk read is `try/catch`-wrapped and
  returns no-swap on any throw (`codexModelSwapPolicy.ts:125-129`); the helper
  always returns `string | undefined`, never throws (`SessionManager.ts`).
- **Zero disk I/O when disabled:** the three fast-path guards (non-codex /
  disabled-or-no-fallback / already-on-fallback) all return BEFORE the
  `read(...)` call; unit tests assert `read===0` for each.
- **Disabled/default path is byte-identical:** on every fast-path the helper
  returns the requested model unchanged, so the builder input is unchanged for
  non-codex agents and codex agents with no config block.
- **Swap-decision correctness:** swaps only on the documented conjunction; uses
  the weekly (`secondary`) window not `primary`; `<=` threshold off-by-one
  covered both ways; never swaps to an empty model.
- **Both spawn paths covered**, enforced by source-assertion tests.
- **No conflict** with RateLimitSentinel (different moment), the shared
  `~/.codex/config.toml` (per-spawn flag override wins), or `/local-model`
  (its model is the helper's input, passes through when off).

Reviewer notes addressed: §5's spawn-path-latency wording was corrected to
acknowledge the `listAllRollouts` directory walk (not just a single tail-read).
One non-blocking nit noted for a future graduation-out-of-dark: the config is
read via an inline cast rather than a typed `codex?` field on
`SessionManagerConfig` — intentional to keep the feature dark without a schema
change; can be promoted to a typed field if/when it ships on by default.
