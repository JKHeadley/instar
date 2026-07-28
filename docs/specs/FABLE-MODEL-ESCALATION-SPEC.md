---
title: "Model-Tier Escalation Policy"
slug: "model-tier-escalation"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "model-tier-escalation.eli16.md"
status: "draft (convergence round 4)"
date: "2026-06-09"
lessons-engaged:
  - "Subscription-auth mandatory / no direct-API path (feedback_anthropic_path_constraints)"
  - "No Silent Degradation to Brittle Fallback (fail-closed)"
  - "Structure > Willpower"
  - "Migration Parity (add-missing-only)"
  - "No dark-ship on dev agents"
  - "Know Before You Claim / A Wall Is a Hypothesis"
  - "Gate latency vs client timeout"
  - "Config-write-clobbers-operator-setting"
review-convergence: "2026-06-09T22:52:13.459Z"
review-iterations: 4
review-completed-at: "2026-06-09T22:52:13.459Z"
review-report: "docs/specs/reports/model-tier-escalation-convergence.md"
approved: true
approved-by: "Justin (operator, topic 23225)"
approved-at: "2026-06-09T23:30:00Z"
---

# Model-Tier Escalation Policy — Spec

**Status:** draft (convergence round 4) · **Author:** Echo · **Date:** 2026-06-09

> **Build target (round-2 Integration-NEW-1):** this work is built against **`main` (v1.3.x)**
> via `instar worktree create` off `JKHeadley/main` — NOT the agent-home checkout (currently the
> stale v1.2.62 lineage). The following cited dependencies exist only in the v1.3.x target:
> `SubscriptionPool` + the `/subscription-pool` quota snapshot (§7), `GuardPostureTripwire` (§10),
> and the **reap-log close event** that §7's lease release ties to (round-3 Integration-NEW-3).
> The remaining code citations (`frameworkSessionLaunch.ts`, `SessionManager` send-keys +
> capture-pane, `routes.ts` session routes, `Session.model`, `types.ts`, `SpawnNonce`,
> `BurnDetector`) resolve in both lineages.

> First concrete instance: Claude **Opus 4.8 → Fable 5**. The mechanism is
> **framework-agnostic** — Codex, Gemini, Pi plug in the same way the day any of them ships an
> "ultra" model; until then they are a strict no-op.

> **Convergence note (round 1 → 2):** review surfaced that the original mid-session-`/model`-swap
> design rested on three mechanisms that do not exist in the codebase (the interactive
> `claude-code` launcher ignores `--model`; a `UserPromptSubmit` hook cannot run a `/model`
> swap; `GET /sessions` reports the launch model, never the live one). v2 **re-architects around
> launch-time escalation as the primary path** and confines mid-session swap to one narrow,
> server-side, verified-before-enable case. Every round-1 finding is mapped in §12.

---

## 1. Motivation

Claude Fable 5 (2026-06-09) is materially stronger than Opus 4.8 on large, multi-file,
long-horizon coding/agentic work (SWE-Bench Pro 80.3% vs 69.2%; 1M context; "works for days in
an agent harness") but costs **~2x**. A live head-to-head (2026-06-09) confirmed the boundary:
on a bounded task **both models tied** — the edge is on the hard, large-context tail. So the
ultra model is used **selectively**, and the selection is **structural, not willpower**.

The same shape recurs for every framework (a cheap default + a pricey ultra). The policy is
specified **generically**, with Claude's Opus→Fable as the first populated entry. (Operator
requirement 2026-06-09: backwards-compatible + fully compatible with Codex/Gemini/Pi; valuable
generically when other frameworks ship ultra models.)

## 2. Goals

- Default every session to its framework's **default model**.
- **Escalate to the framework's ultra model** on two work-modes: (1) spec/project design,
  (2) implementation / long autonomous build.
- **Automatically return to default** — structurally guaranteed, never willpower.
- **Framework-agnostic & backwards-compatible**: a framework with no escalated model defined is
  a strict no-op.
- **Stay inside the subscription billing envelope** — escalation never introduces a per-token
  API path (§7).
- **Config-driven**, full **migration parity**, **cost-guarded**, ships **dark on the fleet but
  ENABLED on dev agents** (Echo/Codey), behind dry-run + a verified live-swap canary.

## 3. Non-Goals

- A fuzzy general "complexity classifier." Triggers are the two explicit work-modes.
- Routing internal background LLM calls (sentinels/gates) — they stay cheap via per-component
  routing. This spec governs the **session/foreground** model only, and §11 structurally
  forbids the escalated id from being selectable by the per-component router.
- Hardcoding any vendor — no model id or vendor name in logic, only in config.

## 3.5 Decision points touched

Introduces (removes/modifies none): a **routing** decision (which model a session runs/swaps
to) — never a **block**. Worst-case failure of every component = the session stays on its
**default** model (today's behavior). No component here can refuse a message, tool call, or
session.

## 4. The Two Triggers (authoritative, framework-agnostic)

| # | Work-mode | Entry signal (deterministic-first) | Mechanism |
|---|-----------|-----------------------------------|-----------|
| 1 | Spec / project design **in the live conversation** | `/spec-converge`; `instar-project create` / initiative design | **mid-session swap** (§5.3) — the one narrow case |
| 2 | Implementation / long autonomous build (**spawned** session) | `/build`, `/autonomous`, `/instar-dev` spawn a session | **launch-time** model (§5.2) — primary, robust |
| — | Conversation / brainstorm / routine | everything else | **default** |

"escalated"/"default" resolve **per the session's framework** (§5.1). No escalated model ⇒ both
resolve to default ⇒ no swap ever.

## 5. Architecture

### 5.1 Per-framework model resolution (generalization core)

A single resolver maps `(framework, tier) → concrete model id | null`, reading **only trusted
config** (never the mode-state file):

```
resolveModel(framework, tier):
  if framework ∉ {claude-code,codex-cli,gemini-cli,pi-cli}: return null   # enum-guarded
  fw = config.models.tierEscalation.frameworks  (Object.create(null) / hasOwnProperty lookup)
  entry = fw[framework]; if !entry: return null
  id = (tier=='escalated') ? (entry.escalated ?? entry.default) : entry.default
  if id == null: return null
  if !/^[A-Za-z0-9._-]{1,64}$/.test(id): AUDIT+return null   # injection-safe; fail-closed
  if id ∉ adapter(framework).knownModelIds: AUDIT+return null # closed enumeration
  return id
```

- `escalated == null` ⇒ resolves to default ⇒ **no swap (backwards-compat contract)**.
- The id is a **closed enum** validated by regex — a config typo or injected value can never
  reach a launch arg or send-keys (resolves Security F1/F2).

### 5.2 Primary mechanism — launch-time escalation (Trigger #2)

`/build`, `/autonomous`, `/instar-dev` **spawn** sessions. The spawn launches the **whole
session on the escalated model** via `--model <id>`. The session is dedicated to that work and
**terminates when done — so there is no de-escalation problem for this path** (it dissolves
round-1 Adversarial-C1 / Integration-M1 / Lessons-C2).

Required code change (round-1 Integration-C1, verified gap): the interactive `claudeCodeBuilder`
(`src/core/frameworkSessionLaunch.ts:140-152`) **does not currently emit `--model`** — only the
codex and headless builders do. This spec's build MUST: (a) add `--model` emission to the interactive
claude builder (mirror the headless builder, resolving via §5.1); (b) widen
`frameworkDefaultModels` (`src/core/types.ts:115`) to all four frameworks; (c) add a
`knownModelIds` closed enumeration to each launch adapter (net-new — precedent `KNOWN_MODELS`
in `commands/route.ts`, per-adapter model maps in `src/providers/adapters/*/models.ts`), since
§5.1 resolves against it; (d) seed **`Session.model`** from the resolved launch model at spawn
(`spawnInteractiveSession`, which today omits it) so `GET /sessions` is an honest oracle (round-1
Integration-C3).

### 5.3 Narrow mechanism — mid-session swap (Trigger #1 only), server-side, verified

In-conversation spec design happens in the **live conversation session**, which cannot be
re-launched. Swapping it requires a real, server-side action — NOT a hook (a `UserPromptSubmit`
hook only emits prompt-context stdout; it cannot run `/model` or drive tmux — round-1
Integration-C2). The contract:

1. **Signal** — a `UserPromptSubmit` reconciler hook's ONLY job is to compute desired-tier from
   §5.4 and, if it differs from the live model, call the server swap endpoint. It never performs
   the swap and never blocks the turn (§6 latency).
2. **Swap endpoint** — `POST /sessions/:name/model-swap` (Bearer `authToken` required, like every
   mutating route): body `{ tier }` (enum) only — **the model id is derived server-side** via
   §5.1, never accepted from the caller. `:name` is resolved by **exact match against the live
   session registry** — never globbed, substring-matched, or concatenated into the tmux target
   (round-2 Security-N1); the only string ever sent to the pane is the server-derived
   `/model <validated-id>`. The endpoint: verifies the session exists, is not protected, and is
   **idle with an empty, prompt-ready input line** (capture-pane confirms both the prompt marker
   and a blank input, closing the live-input-collision window — round-2 Security-F6); injects via
   tmux `send-keys -l -- "/model <id>"` then a **separate** `Enter` keystroke; honors
   `enabled:false`/`dryRun:true`; audits every call (rejected ids escaped+truncated in the audit
   record; raw operator turn text is never logged — round-2 Security-F7). Protected-session
   enforcement is the authorization boundary.
3. **Canary read-back (independent oracle)** — after injection, read the session's live model from
   an oracle **independent of the `Session.model` field the swap just wrote**; only on a confirmed
   match is `Session.model` updated. **The independent oracle is not assumed to exist** (round-3
   Integration-NEW-1): no current code parses the active model from the pane (the existing
   `SessionManager` match at ~L2434 detects the `/model` command *hint*, not the active model, and
   the dashboard badge is derived from `Session.model` itself, so neither qualifies). Establishing
   a real independent read (a capture-pane parse of a live model indicator, a `/status`-style
   probe, or a CLI surface) is the job of the **§5.3 pre-enable canary** — **if no reliable
   independent read can be established, claude-code degrades to launch-time-only** (§5.5/§5.6) and
   the mid-session path is never enabled. If read-back does not confirm within N attempts, **do
   NOT mark reconciled**, behaviourally treat the session as **default**, and raise one Attention
   item (round-1 Adversarial-H5, Lessons-C3). **Accounting fails toward counting** (round-2
   Adversarial-NEW-2): once `/model <escalated>` is *injected* the escalation is counted against
   the §8 budget regardless of read-back — but **counted exactly once per
   (spawn-nonce, tier-transition) episode** (round-3 Adversarial-NEW-5), so canary retries and
   per-turn re-derivations within one episode never multiply the count and cannot drain
   `maxEscalationsPerHour`. The reconciler reconciles behaviour against the **observed** model,
   never its own write-intent.

**Pre-enable proof (A Wall Is a Hypothesis):** before this path is enabled anywhere, a live test
must drive a real session, inject `/model`, and confirm `GET /sessions` reports the change. If
the swap proves unreliable, claude-code falls back to the honest **launch-time-only** contract
(escalation applies on the next spawn), exactly like codex/gemini/pi (§5.5).

### 5.4 Classification: deterministic-first, fail-closed to default

- **Deterministic signals decide it**: the skill-entry signal (below) + active project-initiative
  state + the autonomous-session marker. These cover both triggers and are framework-independent.
- **Skill-entry signal** — the existing `PostToolUse` skill-usage hook
  (`skill-usage-telemetry.sh`, fires when the `Skill` tool returns) records that a trigger skill
  *started*. **This is NOT a skill-exit event** (round-1 Lessons-C2 / Integration-H3): a `/build`
  run continues for hours after that PostToolUse fires. So desired-tier for the in-conversation
  case is **re-derived live every turn** from durable signals, not held as a persisted "escalated"
  flag that must later be "cleared." There is nothing to get stuck. (Whether a `/skill` even emits
  a `Skill` PostToolUse event is verified during the build; if not, the project-initiative / marker
  signals are primary and the telemetry hook is secondary.)
- **Optional LLM intent check** (`llmIntentCheck`, default off) for ambiguous phrasing: runs
  **only over first-party operator turn text** (never inbound peer/file/web content — round-1
  Security-F4), through the shared rate-limited `LlmQueue` (low lane), **time-boxed** to
  `INTENT_CHECK_BUDGET_MS` (default 1500ms), **non-blocking** (applies to the *next* turn, never
  holds the current one), and **fails closed to default** on timeout/unavailability.

### 5.5 De-escalation (return to default) — only where it can actually happen

- **Trigger #2 (spawned):** the session ends → no swap-back needed.
- **Trigger #1 (in-conversation):** desired-tier is re-derived live each turn (§5.4); when the
  trigger condition is no longer true, the next turn's reconciler swaps back to default at the
  idle boundary (human turns reliably fire `UserPromptSubmit` here). **Asymmetric hysteresis**
  (round-1 Scalability-H4): escalate immediately, de-escalate only after the condition has been
  clear for `minTierDwellTurns` (default 1) AND `minTierDwellMs` (default 5min), and never swap
  twice within `minTierDwellMs`. Suppressed flaps are audited.
- **Stale-flag safety:** any mode-state is **self-expiring on read** (`since` vs
  `maxEscalationTtlMs`, default 6h, evaluated lazily inline in the reconciler — no separate
  poller) and is keyed on a **session-instance/boot id** — sourced from the existing unforgeable,
  monotonic **spawn nonce** (`SpawnNonce`), NOT reconstructable as `tmux-name + start-time`
  (round-2 Security-N4) — not just the tmux name, so a `--resume`/respawn/recovery never inherits
  a predecessor's tier (round-1 Adversarial-H1/L1, Lessons-H4). On spawn/resume the launcher
  ignores any pre-existing mode-state not written by the
  current instance.

### 5.6 Per-framework swap capability (machine-checkable, not prose)

Each adapter declares `swapCapability: 'mid-session' | 'launch-time-only'` and its
`knownModelIds`. `claude-code` is `mid-session` **iff** the §5.3 canary passes, else
`launch-time-only`. `codex-cli`/`gemini-cli`/`pi-cli` are `launch-time-only` today (and no-ops
until populated). The reconciler honors the declared capability so "documented, not silently
dropped" is enforced by code (round-1 Integration-L2).

## 6. Performance / hot-path contract

- The `UserPromptSubmit` reconciler is **pure-filesystem** on the common path: read the small
  mode-state + a cached `last-applied-tier` marker; **early-exit no-op when desired == last
  applied** (no HTTP, no tmux, no subprocess). Target **<20ms** for the no-op case (round-1
  Scalability-C1/H2).
- Mid-session swap incurs a **cold prompt-cache full-context re-read at the ultra rate** on the
  next turn — acknowledged cost (round-1 Scalability-H3). This is *why* launch-time is preferred
  and mid-session is the narrow exception, damped by §5.5 hysteresis.
- The skill-entry hook writes the mode-state **only on a tier transition**, never on every
  `PostToolUse` (round-1 Scalability-M5). State dir carries the Spotlight-exclusion marker.

## 7. Subscription billing envelope (core safety invariant)

Escalated sessions run through the **same subscription-backed launch/resume path** as default
sessions — escalation changes only the `--model` value, never the auth/billing surface. **No
per-token direct-API path is ever introduced** (`feedback_anthropic_path_constraints`, round-1
Lessons-C1). `costGuards.requireQuotaHeadroom` reads the subscription pool's **cached** quota
snapshot (never a live poll on the hot path — round-1 Scalability-M7); a capped account ⇒ fall
back to default; **quota state unavailable/errored ⇒ fail closed to default** (round-1
Adversarial-H3). Concurrent escalation onto one account goes through a **reservation/lease**
(fenced, mirroring existing lease patterns) with `maxConcurrentEscalatedPerAccount` — not a bare
headroom read (round-1 Adversarial-H2). **The lease is crash-safe (round-2 Security-N3 /
Adversarial-NEW-1):** it carries a TTL and is keyed on the same spawn-nonce instance id as the
mode-state (§5.5), and is **released on session-end** (tied to the same reap-log close event that
retires the session) — so a hard-crashed escalated session cannot permanently wedge a per-account
slot. A lease whose holder's instance id is no longer live is reclaimable; expiry is evaluated
lazily (no dedicated poller). This gives the lease the same self-healing treatment §5.5 gives the
flag.

## 8. Cost guards (against runaway / abuse)

- **Escalation budget** (round-1 Security-F4, Adversarial-C2): `maxEscalationsPerHour` and a
  daily ultra-token cap; on exceed, pin to default + one Attention item.
- **Which guard binds which path** (round-2 Adversarial-NEW-4): for **Trigger #1** (short
  in-conversation swaps) `maxEscalationsPerHour` is load-bearing; for **Trigger #2** (long-lived
  spawned runs) the load-bearing guards are `maxConcurrentEscalatedPerAccount` (admission) + the
  daily ultra-token cap. A future tuner must not loosen the wrong dial.
- **Mid-run cap enforcement for a launched ultra session** (round-2 Adversarial-NEW-3): because a
  spawned run is launch-time-only (its model cannot be down-swapped), `dailyUltraTokenCap` is
  **admission-control** for *new* escalations AND is **monitored mid-run** by reusing the existing
  **BurnDetector**'s cadence/signal infrastructure (no new poller). This reuse is not free
  (round-3 Integration-NEW-2): BurnDetector today tracks per-`attributionKey` 24h-share / 1h-rate,
  NOT an absolute per-session daily token cap — so the build must add (a) **per-session-instance
  ultra-token attribution** and (b) an **absolute-cap-crossing predicate** on top of it. When a
  running escalated session crosses the daily cap, a **HIGH Attention item** is raised for the
  operator to decide (continue / stop) — **dedup-keyed per (session-instance, day)** so it fires
  once, not once per BurnDetector tick (round-3 Adversarial-NEW-7; HIGH items are never coalesced
  per the topic-flood guard, so the dedup key is mandatory). Honest caveat (round-3
  Adversarial-NEW-6): this guarantees **visibility, not bounded spend** — a launch-time-only run
  cannot be auto-down-swapped (consistent with §3.5 routing-never-block), so ultra spend continues
  until the operator acts. A single multi-day run exceeding the cap is operator-visible, never
  silent.
- **TTL failsafe** (§5.5): expiry **invalidates** the mode-state (quarantine) and requires a
  *fresh* trigger to re-escalate — it does not merely reset the clock (round-1 Adversarial-C2).
  A TTL firing emits one audit breadcrumb (it means the primary path failed).
- **Free windows** (`respectFreeWindows: { "claude-fable-5": "2026-06-22" }`): defined semantics —
  compared as a UTC date, inclusive through the named day; after expiry the quota/budget guards
  apply unchanged (the window relaxes nothing structural — it is informational + drives the
  dev-agent dogfximport window). No silent cost cliff: crossing the date emits one audit note.

## 9. Config schema (`models.tierEscalation`)

```jsonc
{
  "models": {
    "tierEscalation": {
      "enabled": false,            // fleet default OFF; dev agents (Echo/Codey) ship ENABLED (§10)
      "dryRun": true,              // log intended swaps without performing them; enabled:false wins
      "triggers": {
        "skills": ["build", "autonomous", "instar-dev", "spec-converge"],
        "projectDesign": true,
        "llmIntentCheck": false
      },
      "frameworks": {
        "claude-code": { "default": "claude-opus-4-8", "escalated": "claude-fable-5" },
        "codex-cli":   { "default": null, "escalated": null },
        "gemini-cli":  { "default": null, "escalated": null },
        "pi-cli":      { "default": null, "escalated": null }
      },
      "costGuards": {
        "respectFreeWindows": { "claude-fable-5": "2026-06-22" },
        "requireQuotaHeadroom": true,
        "maxConcurrentEscalatedPerAccount": 2,
        "maxEscalationsPerHour": 8,
        "dailyUltraTokenCap": null,
        "maxEscalationTtlMs": 21600000,
        "minTierDwellMs": 300000,
        "minTierDwellTurns": 1
      }
    }
  }
}
```

Absent framework key / `escalated:null` ⇒ untouched (backwards-compat contract). `default:null`
⇒ use the account default (today's behavior).

## 10. Migration parity & rollout

- **Config** — `migrateConfig()` adds `models.tierEscalation` **add-missing-only**; it MUST NOT
  overwrite an existing `enabled`/`dryRun` (round-1 Lessons-H2; the burn-alert clobber incident).
- **Hooks** — reconciler + skill-entry changes are built-in (`instar/`) hooks → always-overwritten
  on migration. Any new `UserPromptSubmit` registration is **append-with-dedup** via
  `migrateSettings()` (precedent `PostUpdateMigrator.ts:3477`), and added to
  `src/templates/hooks/settings-template.json` for new agents.
- **CLAUDE.md** — both `generateClaudeMd()` (`src/scaffold/templates.ts`, new agents) **and**
  `migrateClaudeMd()` (existing). Agent-facing awareness with the **proactive-trigger** form;
  tagged experimental/dark per maturity-honesty (not announced as a finished user capability).
- **Guard posture** — escalation enable/disable flips are added to the GuardPostureTripwire
  surface, so a *cost-increasing* enable gets the same visibility as a guard-disable (round-1
  Lessons-H2).
- **Dev-agent enablement (No dark-ship on dev agents, round-1 Lessons-H1):** Echo's + Codey's
  `.instar/config.json` are flipped `enabled:true` **in the same ship**, gated behind the §5.3
  pre-enable canary passing. Fleet stays dark.
- **Multi-machine** (round-1 Integration-H2): mode-state is per-machine, non-replicated;
  desired-tier is re-derived from durable signals on the receiving machine. A topic transfer
  **resets to default** and requires a fresh trigger (the safe direction).

## 11. Testing (all three tiers + wiring integrity)

- **Unit**: resolver returns escalated/default correctly; **`escalated:null` ⇒ default, no swap
  (backwards-compat)**; unknown framework ⇒ null ⇒ no-op; **malicious/malformed model id
  (newline, `;`, `Enter`, >64 chars) ⇒ rejected, fail-closed**; LLM-intent AND quota-guard paths
  both fail closed to default; TTL invalidates (not just resets); hysteresis suppresses a flap;
  per-component router cannot select the escalated id.
- **Integration**: `POST /sessions/:name/model-swap` requires Bearer auth, derives id server-side,
  refuses protected/non-idle sessions, honors enabled/dryRun, updates `Session.model`; a
  non-claude framework with no escalated model performs zero swaps.
- **E2E**: spawn a `claude-code` session via a trigger, assert `GET /sessions` reports the
  escalated model (requires §5.2 live-model seeding); spawn a `codex-cli` session, run the same
  trigger, assert the model never changes (backwards-compat alive). Mid-session: drive the §5.3
  canary end-to-end (the pre-enable proof IS this test).
- **Wiring integrity**: reconciler hook registered + non-noop; skill-entry writes only on
  transition; swap endpoint reaches the per-framework adapter (dependency-injected, not a stub);
  audit anomaly feeds the BurnDetector/Attention surface (round-1 Adversarial-M2).

## 12. Round-1 finding → resolution map

| Round-1 finding | Resolution |
|---|---|
| Sec-F1/F2 id→send-keys injection | §5.1 closed-enum + regex; §5.3 `send-keys -l --` + separate Enter; id never from file |
| Sec-F3 mode-state untrusted | §5.1 id re-resolved from config; §5.5 schema/enum-validated, atomic, instance-keyed |
| Sec-F4 prompt-injection cost-DoS | §5.4 first-party text only; §8 escalation budget |
| Sec-F5 swap endpoint auth | §5.3 Bearer, server-side id, idle/protected checks |
| Scal-C1/H2 reconciler latency | §6 pure-fs fast path, <20ms no-op; intent check time-boxed/non-blocking |
| Scal-H3/H4 cold-cache flap | §5.5 hysteresis/dwell; §6 acknowledged; launch-time preferred |
| Scal-M5/M6/M7 churn/herd/quota | §6 write-on-transition; §5.4 LlmQueue; §7 cached quota snapshot |
| Adv-C1/Int-M1 autonomous de-escalation | §5.2 launch-time → session ends, no swap-back needed |
| Adv-C2 TTL re-arms | §8 TTL invalidates + fresh-trigger required |
| Adv-H1/H5/Less-C3 stale flag / silent swap-fail | §5.3 canary read-back; §5.5 self-expire + instance key |
| Adv-H2/H3 concurrent/quota fail-open | §7 lease + cap; fail-closed on unknown quota |
| Adv-H4 "/autonomous"≠hard work | §8 budget bounds blanket escalation; §5.2 dedicated spawned session |
| Int-C1 claude builder no `--model` | §5.2 explicit code change |
| Int-C2 UPS hook can't swap | §5.3 server-side endpoint; hook only signals |
| Int-C3 GET /sessions launch-only | §5.2 seed + §5.3 mutate `Session.model` |
| Int-H1 frameworkDefaultModels type | §5.2 widen to 4 frameworks |
| Int-H3/Less-C2 no skill-exit event | §5.4 re-derive live, no persisted flag to clear |
| Less-C1 subscription envelope | §7 invariant |
| Less-H1 dark-ship dev agents | §10 enable Echo/Codey same ship |
| Less-H2 config clobber | §10 add-missing-only + tripwire |
| Less-M4 open-Qs are deferrals | resolved in §5.2/§5.3/§5.6 below |

## 13. Open questions — now resolved

1. *Mid-run swap needed?* No for Trigger #2 (launch-time, session ends). Mid-session swap scoped
   to Trigger #1 only.
2. *In-conversation swap mechanism?* Server-side endpoint + canary (§5.3), not a hook.
3. *Non-claude swap verbs?* `launch-time-only` declared per adapter (§5.6); no-op until populated.
4. *Quota arbitration?* Lease + cap; fail closed to default (§7).
5. *Overlap with per-component routing?* Structurally forbidden (§3/§11).

Remaining genuine unknown, tracked (not deferred): the §5.3 live `/model`-swap reliability — its
pre-enable canary IS the gate; if it fails, claude-code degrades to launch-time-only honestly.
