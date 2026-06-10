# Side-Effects Review — GrowthMilestoneAnalyst dev-agent gate correction

**Change:** Make the GrowthMilestoneAnalyst honor the standard `developmentAgent`
dark-feature gate instead of a hardcoded `enabled: false`. The original slice-1
implementation shipped dark for **every** agent (including dev agents like echo),
which contradicts the established convention used by secret-sync, boot
self-knowledge, the resource sampler, warm-session A2A, etc.: dark-features OMIT
`enabled` from their config default and resolve `enabled ?? !!config.developmentAgent`
at runtime so the dev agent (the dogfooding ground) runs them LIVE while the fleet
stays DARK.

**Files:**
- `src/config/ConfigDefaults.ts` — removed the hardcoded `enabled: false` from the
  `monitoring.growthAnalyst` block (and rewrote the comment to describe the gate).
- `src/server/AgentServer.ts` — construction now resolves
  `growthAnalystEnabled = monitoring?.growthAnalyst?.enabled ?? !!developmentAgent`,
  and feeds that resolved value into `resolveGrowthSettings({ ...block, enabled })`
  so `GET /growth/status` honestly reports `enabled: true` on a dev agent. The
  `resolveGrowthSettings` call is now optional-chained so the gate can be true even
  with no `monitoring.growthAnalyst` block present (dev agent, defaults only).
- `tests/unit/growth-analyst-gate-wiring.test.ts` — new wiring-integrity tests
  (config omits `enabled`, migration parity, both-sides resolution, source-level
  gate assertions).

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?
None. The change ENABLES the feature on dev agents; it never rejects an input. An
operator who explicitly sets `monitoring.growthAnalyst.enabled: false` still
force-darks the feature even on a dev agent (explicit value wins via `??`), and an
explicit `true` still enables it fleet-wide — both preserved and tested.

## 2. Under-block — what failure modes does this still miss?
The analyst remains slice-1: it COMPUTES + serves the digest over `/growth/*` but
does NOT message the user on a schedule (that's the deliberately-separate next
slice). So a dev agent now runs the analyst live but still won't proactively speak
until the messaging slice lands. This is by design (avoid swinging from too-quiet
to too-noisy), not a regression introduced here. No new under-block.

## 3. Level-of-abstraction fit — right layer?
Yes. The gate resolution lives in `AgentServer` construction exactly where every
other dark-feature gate resolves (`standard_development_agent_dark_feature_gate`),
and the default omission lives in `ConfigDefaults` exactly like warmSessionA2A and
boot self-knowledge. No new layer; it joins the existing one.

## 4. Signal vs authority compliance (docs/signal-vs-authority.md)
Compliant. The GrowthMilestoneAnalyst is a SIGNAL-PRODUCER: it reads rollout
stages, the approval ledger, and the correction ledger and computes findings. It
holds NO blocking authority — it never filters a message, blocks an action, or
gates information flow. This change only determines WHETHER that signal-producer
runs on a given agent; it adds no brittle-check-with-authority. The routes remain
read-only.

## 5. Interactions — shadowing, double-fire, races?
None. The construction is guarded by its own try/catch (failure is non-fatal and
null-instances the analyst → `/growth/*` 503-stubs). No PostUpdateMigrator entry
writes `growthAnalyst`, so the gate is the sole resolver — there's no migration
that could write `enabled` to disk and shadow the runtime gate. The
`resolveGrowthSettings({ ...block, enabled })` merge does not mutate config.

## 6. External surfaces — visible to other agents/users/systems?
On the dev agent only, `/growth/digest`, `/growth/findings`, `/growth/status`,
`POST /growth/tick` flip from 503 to 200 after the next server boot (Claude Code
loads config once at session/server start — running processes pick it up on
restart). Fleet agents are unaffected (still 503). No agent-to-agent surface, no
Telegram surface (the analyst does not message in this slice). The
`/growth/status` `enabled` field now reads `true` on a dev agent (was a latent
`false` had the routes ever been forced live) — this is the honesty fix.

## 7. Rollback cost — back-out if wrong?
Trivial and reversible. Two ways: (a) operator sets
`monitoring.growthAnalyst.enabled: false` in `.instar/config.json` and restarts —
force-darks it immediately, no code change; (b) git revert of this commit restores
the hardcoded `enabled: false`. No data migration, no state repair — the analyst's
only durable artifact is `state/growth-milestone-analyst/stage-journal.json`, which
is observe-only and self-heals (a missing/stale journal just recomputes on the next
observe). Worst case is a dev agent serving an unused read route.

## No deferrals
This change is complete: the gate is wired, the default is corrected, the status
honesty is fixed, and the wiring tests cover both sides. Nothing is deferred.

## Second-pass review (independent)
**VERDICT: Concur with the review.** An independent reviewer audited the diff,
the analyst source, the routes, and the migrators:
- Read-only/signal-only confirmed: `computeFindings`/`buildDigest`/`getStatus`
  never gate on `settings.enabled`; `isEnabled()` only feeds the informational
  status field; routes guard solely on `if (!ctx.growthMilestoneAnalyst)` — so
  constructing the analyst is sufficient to make it live, and the component holds
  no blocking authority.
- Gate matches the established convention (byte-identical to the resource
  sampler's `?? !!options.config.developmentAgent`); explicit `enabled` wins both
  ways; both sides tested.
- No fleet leak / no disk write: non-dev agents resolve to false → null → 503;
  grep of PostUpdateMigrator returned zero `growthAnalyst` references, so no
  migration writes `enabled` to disk; `applyDefaults` only backfills missing
  fields (operator `enabled:false` survives).
- No optional-chaining/merge bug: `resolveGrowthSettings({ ...(block ?? {}),
  enabled })` is safe when the block is absent and cannot throw; the spread sets
  `enabled` last so it deterministically wins; no needed field dropped.
- All seven side-effects claims match the code; new test file passes 6/6.
