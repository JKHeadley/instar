# Side-Effects Review — Model-Tier Escalation Policy (Opus 4.8 → Fable 5, framework-agnostic)

**Version / slug:** `model-tier-escalation`
**Date:** `2026-06-09`
**Author:** `Echo`
**Second-pass reviewer:** `pending (required — touches session lifecycle + routes)`
**Spec:** `docs/specs/FABLE-MODEL-ESCALATION-SPEC.md` (converged r4, approved by Justin)

> LIVING DOCUMENT during the build — finalized at /instar-dev Phase 4 before the
> closing commit. Each incremental commit updates the Files-touched inventory.

## Summary of the change

Implements the converged Model-Tier Escalation Policy: sessions default to their
framework's default model and escalate to the framework's ultra model
(claude-fable-5, first populated entry) only for the two spec-defined work-modes,
with launch-time escalation as the primary path and a narrow, server-side,
canary-verified mid-session swap. Fail-closed everywhere: the worst-case failure
of every component is "the session stays on its default model" (§3.5 —
a routing decision, never a block).

## Decision-point inventory

- `resolveTierModel` (src/core/ModelTierEscalation.ts) — **add** — routing-only resolver; rejects = null = default model. Hard-invariant validators (regex + closed enum) at the boundary — signal-vs-authority exempt class ("structural validators").
- `EscalationGovernor.admitEscalation` (src/core/EscalationGovernor.ts) — **add** — admission control for COST, not for messages/sessions; refusal = stay on default.
- `POST /sessions/:name/model-swap` (src/server/routes.ts + src/core/ModelSwapService.ts) — **add** — mutating session route; refusals (protected/non-idle/disabled) are safety guards on a session-mutating action (exempt class), all retryable.
- `UltraSessionCapMonitor` (src/monitoring/) — **add** — SIGNAL-ONLY: raises a HIGH Attention item; never blocks or down-swaps (§8 visibility-not-bounded-spend).
- Hooks `model-tier-skill-entry.sh` / `model-tier-reconciler.js` — **add** — signal writers; the reconciler only *requests* a swap from the server authority; it never blocks a turn.
- `/sessions/spawn` model allowlist (routes.ts) — **modify** — widened (claude model ids incl. claude-fable-5); a pure allowlist extension, no new block path.

## Files touched (running inventory)

- src/core/ModelTierEscalation.ts (new) + tests/unit/modelTierEscalation-resolver.test.ts (new)
- src/core/EscalationGovernor.ts (new) + tests/unit/escalationGovernor.test.ts (new)
- src/core/ModelSwapService.ts (new) + tests/unit/modelSwapService.test.ts (new) + tests/unit/modelTier-launchMechanisms.test.ts (new §5.2 pins)
- src/core/SessionManager.ts (export IDLE_PROMPT_PATTERNS; sendInput gains `--` end-of-options hardening)
- src/server/routes.ts (POST /sessions/:name/model-swap; spawn allowlist claude branch → closed claude id enum incl. claude-fable-5)
- src/server/AgentServer.ts (governor + swap service + UltraSessionCapMonitor constructed on the production init path; sessionReaped lease release; BurnDetector receives ultraCapMonitor)
- src/core/types.ts (InstarConfig.models.tierEscalation typed)
- src/monitoring/GuardPostureTripwire.ts (models.tierEscalation.enabled/dryRun posture + HIGH cost-increasing-enable attention)
- src/monitoring/BurnDetector.ts (optional ultraCapMonitor dep, ticked before early-returns)
- src/monitoring/TokenLedger.ts (tokensByModelSince read-only aggregate)
- src/monitoring/UltraSessionCapMonitor.ts (new) + tests/unit/ultraSessionCapMonitor.test.ts + tests/unit/guardPosture-modelTier.test.ts (new)
- src/templates/hooks/model-tier-skill-entry.sh (new — §5.4 PostToolUse/Skill mode-state writer, write-on-transition, instance-keyed, fail-closed) + src/templates/hooks/model-tier-reconciler.js (new — §5.4 UserPromptSubmit reconciler, pure-fs fast path, TTL quarantine, asymmetric hysteresis, observed-outcome reconciliation; canonical sources mirrored byte-identical into PostUpdateMigrator getters)
- src/core/PostUpdateMigrator.ts (§10 migration parity: byte-identical hook getters, always-overwrite migrateHooks entries, append-with-dedup migrateSettings registrations, getHookContent union/cases, migrateClaudeMd content-sniffed awareness section)
- src/config/ConfigDefaults.ts (models.tierEscalation in SHARED_DEFAULTS via the DEFAULT_TIER_ESCALATION_CONFIG import — single source of truth; applyDefaults add-missing-only ⇒ an operator's enabled/dryRun is never overwritten)
- src/commands/init.ts (installHooks writes both §5.4 hooks via migrator.getHookContent — fresh-init/migrate parity, no deferred-install allowlist gap)
- src/templates/hooks/settings-template.json (UserPromptSubmit reconciler + PostToolUse/Skill skill-entry registrations for new agents)
- src/scaffold/templates.ts (generateClaudeMd "Model-Tier Escalation" awareness section, proactive-trigger form, tagged EXPERIMENTAL; byte-identical to the migrateClaudeMd section — parity-tested)
- tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts (new — 15 §10 parity tests: byte-equality drift guards, always-overwrite, settings dedup + idempotency, config never-overwrite + array-leaf preservation, CLAUDE.md section byte-parity, settings-template registrations)
- tests/unit/model-tier-hooks-behavior.test.ts (new — 16 behavioral tests EXECUTING both shipped hook templates as real child processes: write-on-transition, fail-closed inerts, pure-fs fast path with zero HTTP, transition POST carrying tier-only + Bearer, observed-outcome reconciliation, stable-refusal cooldown, TTL quarantine + breadcrumb, asymmetric hysteresis, instance-key non-inheritance)
- tests/integration/model-tier-swap-route.test.ts (new — 13 §11 route tests: tier-only body, raw-model-id 400, 404/403/409/429 refusal mapping, dryRun no-inject, oracle-confirmed swap, codex zero-swap, 503 unwired, spawn fable allowlist both directions)
- tests/e2e/model-tier-escalation-lifecycle.test.ts (new — 6 §11 lifecycle tests on the PRODUCTION AgentServer init path: feature-alive (404 not 503), Bearer 401, escalated spawn reported by GET /sessions, codex no-op, dryRun gate chain, §5.3 canary vs REAL tmux through the real hardened send-keys/capture primitives)

---

## 1. Over-block

What legitimate inputs does this reject that it shouldn't?

- **A legitimate escalation can be refused** by the idle gate (`not-idle`), the dwell backstop, the hourly budget, the per-account concurrency cap, or a missing/stale quota snapshot (fail-closed when `requireQuotaHeadroom`). Every one of these refusals is **retryable and costs only "stay on the default model"** — the spec's explicit worst case (§3.5). The reconciler retries at the next idle boundary; nothing is lost permanently.
- **Pi-cli is closed-empty by design** — ALL pi escalations refuse until a real per-provider enumeration exists. This over-blocks a hypothetical valid pi ultra id deliberately (two independent fail-closed layers); the alternative (open pi ids reaching send-keys) is the Sec-F1 injection class.
- **The spawn allowlist** now accepts only the closed claude enum + CLI tier aliases; an operator wanting a brand-new Anthropic model id the enum hasn't caught up with gets a 400 with the full accepted list named. The fix is a one-line enum addition; we accept that cost for a closed injection surface.
- **The stable-refusal cooldown** (reconciler, 10 min) can delay a *newly-enabled* agent's first escalation by up to 10 minutes after the operator flips `enabled` (the marker remembers `refused:disabled`). Accepted: self-heals within one cooldown window, and a session restart (which the CLAUDE.md section tells the operator to do anyway) clears it instantly.
- **De-escalation is exempted from the enabled/dryRun refusals** (rescue path, added on Phase-5 review): `tier:'default'` for a session currently ON an escalated id always proceeds (idle/protected/dwell/canary gates still apply). Without this, the one refusal class whose failure direction was MORE spend lived in exactly the rollback state — every other refusal in the feature still costs only "stay on the default model".

## 2. Under-block

What failure modes does this still miss?

- **A mid-session swap that the CLI acknowledges but does not honor** (CLI bug) would be recorded as confirmed — the oracle reads the CLI's own ack line; it cannot see the wire. Bounded by: the TokenLedger attributes real spend per model id, so the UltraSessionCapMonitor + BurnDetector surface a mismatch in cost terms.
- **`/sessions/input` (free-text route) can still type `/model <anything>`** into a pane — operator-authority surface that predates this feature and is Bearer-gated; the escalation policy neither widens nor can close it. Tracked as the route's own pre-existing posture, not a regression from this change.
- **dailyUltraTokenCap defaults to null** (no cap) — §9's converged default. Spend visibility (cap monitor is signal-only) rather than bounded spend is the ratified §8 posture; the free-window expiry (2026-06-22) emits one audit note, not a block.
- **Quota snapshots are cached**, never live-polled (§7 — deliberate). A snapshot can be stale-optimistic for one swap; bounded by maxConcurrentEscalatedPerAccount and the hourly budget.

## 3. Level-of-abstraction fit

- The swap **authority** lives server-side in ModelSwapService (single funnel) — hooks are dumb signal writers; the route is a thin tier-enum validator. This is the layer split Int-C2 demanded (a UserPromptSubmit hook cannot swap).
- Cost admission is its own layer (EscalationGovernor) feeding the swap service, not inlined — the same shape as LlmQueue/QuotaTracker precedent.
- Config defaults ride the existing ConfigDefaults registry instead of a bespoke migrateConfig block — the canonical "add a default once, init + migration both get it" chokepoint.
- The §5.4 reconciler deliberately does NOT reuse the heavier feature-rollout reconciler machinery: a per-prompt hook must stay pure-fs/<20ms on the no-op path (Scal-C1).

## 4. Signal vs authority compliance

Reviewed against `docs/signal-vs-authority.md`:

- **Signals:** skill-entry hook (writes mode-state), reconciler (requests; never blocks the turn, emits no prompt context), UltraSessionCapMonitor (Attention only), GuardPostureTripwire coverage (visibility on enable-flips), audit JSONL everywhere.
- **Authorities:** ModelSwapService refusals are safety guards on a session-mutating action (protected/non-idle/disabled) — the exempt structural-validator class, all deterministic, all retryable, none judging content. resolveTierModel's closed enum + regex are hard-invariant boundary validators (exempt class).
- **No brittle heuristic holds blocking authority over agent behavior anywhere in the feature.** The one heuristic (pane-idle detection) fails CLOSED to "no swap now, retry later" — it can never block work, only defer a model upgrade.

## 5. Interactions

- **Dwell exists twice on purpose** (reconciler hysteresis + server-side dwell backstop): the server-side one is the authority; the reconciler's is traffic suppression. They cannot disagree into a wrong state — both directions converge on "fewer swaps".
- **Double-fire safety:** skill-entry is write-on-transition (byte-identical second write suppressed); reconciler marker prevents per-turn re-POSTs; route+service are idempotent (`already-on-tier` noop).
- **SessionReaper/zombie cleanup:** the sessionReaped event releases the governor lease — the same close event that retires the session; TTL + liveness probe cover a crashed holder. No new kill path is introduced.
- **Shadowing:** the spawn-allowlist widening extends an existing validator — it does not shadow the §5.1 resolver because spawn-time ids are operator-chosen, escalation-time ids are config-resolved; both end at closed enums.
- **BurnDetector tick now also ticks UltraSessionCapMonitor** — additive, before early-returns, no change to burn behavior (unit-pinned).
- **Hook ordering:** the reconciler appends to UserPromptSubmit after telegram-topic-context; both are non-blocking and order-independent (the reconciler's common path does no HTTP).

## 6. External surfaces

- **New Bearer-gated route** POST /sessions/:name/model-swap — local server surface only; tier-enum body, server-derived model id, raw-id requests hard-400 (Sec-F5 probe visibility).
- **Other agents/users:** none until an operator enables; the fleet ships `enabled:false` + `dryRun:true` (§10). Echo + Codey are flipped to enabled+dryRun in this ship gated on the live canary (no dark-ship on dev agents, Lessons-H1).
- **Timing/runtime dependence:** the canary depends on CLI output format ("Set model to …"); an unrecognized format degrades to `unconfirmed` (honest, Attention-raised, budget-counted) — never a silent wrong state. Multi-machine: mode-state is per-machine and instance-keyed; a topic transfer resets to default and needs a fresh trigger (the safe direction, Integration-H2).
- **CLAUDE.md/AGENTS.md:** the awareness section ships in generateClaudeMd + migrateClaudeMd AND is mirrored to the framework shadows (AGENTS.md/GEMINI.md) via the markers[] allowlist — a Codex/Gemini agent spawns claude-code sessions through the same spawn/swap routes, so the awareness applies there too (and the feature-delivery-completeness structural guard enforces the parity). Mid-session swap stays claude-code-only; other frameworks are honest no-ops.

## 7. Rollback cost

- **Config:** flip `models.tierEscalation.enabled:false` (or `dryRun:true`) — takes effect at the next hook firing/swap request with NO restart (config is re-read per call); GuardPostureTripwire records the flip. A session escalated at that moment does NOT auto-de-escalate (the reconciler goes inert when disabled — its zero-cost fast path); the working corrections are ONE rescue POST (`tier:'default'`, which bypasses the disabled/dry gates for a session on an escalated id and is audited as `rescue-deescalation`) or a session restart. If the framework's `default` model is configured null (use-account-default), the rescue swap has no concrete target id and restart is the rollback path.
- **Code:** the feature is additive; reverting the commits removes routes/hooks/monitors cleanly. Hooks are always-overwritten built-ins, so a release that removes them also removes the registrations via migrateSettings' own files (no stranded agents on broken templates).
- **State:** mode-state/marker/audit files under `.instar/state/model-tier-escalation/` are inert when disabled; safe to delete wholesale. No data migration in either direction.
- **Worst production wrongness** = a session running on the wrong tier — corrected by one rescue POST (tier 'default', works even under enabled:false/dryRun:true) or a session restart. No user data, no message flow, no session lifecycle depends on the feature being right.

## Conclusion

All seven questions answered; no unresolved violation found. The change holds no
brittle blocking authority over agent behavior; every refusal degrades to "stay
on the default model" and is retryable; rollback is a config flip with no
restart. Ships dark on the fleet (enabled:false), enabled+dryRun on Echo/Codey
gated on the live §5.3 canary. Second-pass review (required: session lifecycle +
routes) appended below.

---

## Second-pass review (Phase 5 — independent reviewer subagent)

**Round 1 verdict:** Concern raised: the rollback levers themselves disabled
de-escalation — `enabled:false` refused (`'disabled'`) and `dryRun:true`
no-op'd (`'dry-run'`) a `tier:'default'` swap for a session already ON the
escalated model, stranding it on `claude-fable-5` until restart. That made the
disabled-refusal of a de-escalation the one refusal whose failure direction
was MORE spend (inverting §3.5), and the artifact's §1/§7 rollback runbook
("corrected by one POST") did not work in exactly the state it exists for.
The reviewer verified everything else in the artifact against the code and
concurred (signal-vs-authority compliance, swap flow + status mapping,
governor fail-closed + lease lifecycle incl. lazy reclaim after killSession,
migration parity never-overwrite, all five test suites green). Non-blocking
notes: governor saveState disk failure fails open on persistence (loud warn,
consistent with ratified posture); a confirmed de-escalation holds the
per-account lease until session end/TTL (over-conservative, safe direction).

**Resolution (design iterated before commit):** rescue de-escalation added in
`ModelSwapService.swap` — `tier:'default'` for a session currently on an
escalated id (per `escalatedModelIds(cfg)`) bypasses the `enabled`/`dryRun`
gates; idle/protected/dwell/canary gates and the server-derived id still
apply; the event is audited as `rescue-deescalation`. Fleet installs stay
inert (their sessions are never on an escalated id). §1/§7 above amended to
match, including the `default:null` caveat (restart is the rollback there).
Pinned by three new integration tests (rescue under disabled, rescue under
dryRun, disabled still refuses non-escalated default-tier requests).

**Round 2 (re-audit of the resolution):** **Concur with the review.** The
reviewer verified: (1) the rescue path cannot inject an arbitrary model — the
route hard-400s any body model id, the rescue target is the server-derived,
closed-enum-validated DEFAULT id, and the gate ordering keeps unknown-session/
launch-time-only/protected/null-default in front of the rescue check (so
codex/gemini/pi sessions and `default:null` configs never reach it); (2)
disabled fleet installs stay inert beyond the strictly cost-reducing
direction — `escalatedModelIds` only contains closed-enum ids distinct from
the configured default, pinned by the third RESCUE test; (3) the dry-run
observation contract for ESCALATIONS is intact (`cfg.dryRun &&
!isRescueDeescalation`, with rescue definitionally tier:'default'), and rescue
swaps under disabled/dry are loudly audited as `rescue-deescalation`; (4) the
three integration tests pin the load-bearing behavior over the real HTTP
pipeline and the amended §1/§7 now state the runbook honestly. One
non-blocking observation: an operator who inverts the trusted config
(declaring the ultra id as `default`) could make the rescue direction
increase spend — that is the Sec-F3 trusted-config authority, not a
caller-reachable hole.

---

## Live §5.3 pre-enable canary (2026-06-09) — findings & resolutions

The §10-required live canary (REAL claude CLI 2.1.170 in REAL tmux, REAL
ModelSwapService from dist) was run on this machine. **Final verdict: PASS**
(escalate to claude-fable-5 oracle-confirmed in 2 read-back attempts;
de-escalate to claude-opus-4-8 confirmed in 1) — but only after it caught two
real §5.3 bugs the synthetic tests could not see, both fixed and pinned:

1. **Idle detection failed against every real session.** The real CLI renders
   the prompt as `❯` (U+276F); `paneIdleWithEmptyInput` matched ASCII `>`
   only, so every live swap refused as `not-idle` (fail-closed — the safe
   direction, but the feature would have been dead on arrival). Fixed:
   `❯` normalized to `>` before matching; live format pinned in unit tests.
2. **The oracle never confirmed.** The real CLI acks with the DISPLAY NAME
   ("Set model to Fable 5 and saved as your default for new sessions"), not
   the id; `paneConfirmsModel` required the exact id, so every live swap
   ended `unconfirmed` (honest-degrade, still wrong-by-default). Fixed: the
   ack matcher accepts the exact id OR the display form derived from the
   closed-enum id (family + up to two version components — "Fable 5",
   "Opus 4.8"); sibling versions do not cross-confirm; pinned in unit tests.
3. **External surface discovered: `/model <id>` PERSISTS as the account's
   default model for new sessions** ("…and saved as your default"). A
   mid-session escalation therefore changes what the account's NEXT sessions
   launch with until the de-escalation swap-back runs (which symmetrically
   restores it). The canary's first failed run left the operator's account
   default on Fable 5; it was manually restored to claude-opus-4-8 within
   minutes and the passing canary run restores it inherently. This is now a
   KNOWN side effect of any mid-session swap: an unconfirmed/interrupted
   escalation can leave the account default escalated. Mitigations already
   structural: launch-time escalation is the primary path (§5.2, explicit
   --model per spawn overrides the account default), the dwell/TTL bounds
   re-swaps, and the audit trail records every injection. Accepted for the
   dry-run dev rollout; flagged for spec §5.6 follow-through before any
   non-dry fleet enablement. <!-- tracked: model-tier-escalation dev dogfood window (echo/codey dryRun observation through 2026-06-22 free window) -->

## §10 dev-agent enablement record (2026-06-09)

Canary PASSED ⇒ per the approved spec, `models.tierEscalation` was written to
the two dev agents' live `.instar/config.json` with **enabled:true,
dryRun:true** (full §9 block; backups at `config.json.bak-model-tier`):
- `/Users/justin/.instar/agents/echo/.instar/config.json`
- `/Users/justin/Documents/Projects/instar-codey/.instar/config.json`
The fleet stays dark (enabled:false via ConfigDefaults). The §5.4 hooks read
config from disk per-firing (live immediately); the in-process swap engine
reads the boot-loaded config (live on each server's next restart).
GuardPostureTripwire surfaces the cost-increasing enable on its next tick.

## Ride-along incident fixes (discovered making the suite green)

- **PostUpdateMigrator.migrateFleetWatchdog mutated MACHINE-GLOBAL launchd
  state from unit tests**: every darwin test that ran `migrate()` with a
  redirected `$HOME` booted out the REAL fleet watchdog and bootstrapped one
  pointing at the test tmpdir (RunAtLoad → wrote logs into the tmpdir
  mid-cleanup → the worktree-spotlight-exclusion ENOTEMPTY failures; after
  cleanup the machine's watchdog service pointed at a DELETED plist — fleet
  watchdog silently dead until the next real update; CI never sees it,
  launchd is darwin-only). Fixed: launchctl bootout/bootstrap skipped under
  a test harness (`VITEST`/`NODE_ENV==='test'`); file writes stay active
  (hermetic). The machine's real watchdog was re-bootstrapped from the
  canonical plist during this session.
- **tests/e2e/session-management-e2e.test.ts build-context restore raced
  mock startup**: the test ran `monitorTick()` gated only on tmux-session
  existence, recording the pane cwd BEFORE the mock's `cd` executed —
  deterministic failure on a loaded machine. Fixed: the test now waits for
  the mock's prompt OUTPUT (printed after the cd) before ticking.
- **tests/e2e/compaction-telegram-context.test.ts** asserted UserPromptSubmit
  has exactly ONE entry in settings-template.json; the model-tier reconciler
  registration makes it two. Fixed to assert membership of the entry it
  cares about, not a count.
- **no-silent-fallbacks gate**: the two §7 fail-closed probe catches in
  EscalationGovernor (quota snapshot, ultra-token ledger) were parser-counted
  as silent. They are fail-closed CONVERSIONS — each errored probe becomes an
  AUDITED structured refusal ('quota-unavailable' / 'daily-cap-exhausted') on
  the very next branch — so they carry in-brace @silent-fallback-ok
  justifications rather than a baseline bump.
- **no-silent-fallbacks gate (CI follow-up)**: CI shard 3/4 (node 20+22)
  flagged one more — the model-tier escalation init in `AgentServer` is wrapped
  in a cascade-isolation `try/catch` (an init failure must never 503 the server;
  the feature degrades to no-escalation and re-attempts next boot) but lacked the
  annotation, so the ratchet counted it (464 > baseline 463). Annotated
  `@silent-fallback-ok` at the catch (mirrors the a2a-delivery-tracker init
  guard); local run now 462. No behavior change.
