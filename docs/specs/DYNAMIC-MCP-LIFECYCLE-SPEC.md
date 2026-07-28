---
title: Dynamic MCP Lifecycle — lean baseline, load-on-demand, idle-offload
date: 2026-06-27
author: echo
slug: dynamic-mcp-lifecycle
parent-principle: "Bounded Blast Radius"
parent-principle-fit: "Heavy, mostly-idle MCP servers (a whole Chromium for Playwright, an Electron bridge) stacked across sessions were a dominant share of the steady-state process footprint behind the 2026-06-26 resource-exhaustion kernel panic. A lean baseline + on-demand load + idle-offload bounds the per-machine MCP footprint to what is actually in use, instead of letting idle browser engines accumulate until the host hits a kernel object limit. This is the 'reduce' lever that complements the ProcessFootprintMonitor 'measure' lever (#1291)."
review-convergence: internal-adversarial-convergence-2026-06-27
review-convergence-detail: "Two parallel adversarial reviewers (correctness/concurrency/lifecycle + integration/safety/spec-fidelity) audited the first-draft spec against the real codebase (McpProcessReaper, SessionRefresh, frameworkSessionLaunch, devAgentGate). Converged after folding ALL findings. 2 CRITICAL: (C1) the central 'MCP child dies with the old session, reclaimed by the reaper' claim was FALSE — the reaper's own header states children reparent to launchd and survive for days, so offload-via-restart-alone would LEAK a Chromium per offload and worsen the footprint → FIXED to capture heavy child PIDs before the kill + direct-reap the captured orphans after the restart confirms (a dead-session orphan kill, not a live-proc-invariant inversion); (C4) the agent is the only caller over the shared Bearer so it could self-certify approved:true → FIXED to a server-minted single-use nonce bound to (topicId,kind,server) + operator-authenticated-channel approval (dashboard PIN / MessageSentinel-bound yes), agent-forwarded approved:true is structurally insufficient. MAJOR folded: rollback strands sessions unless the builder enabled-gates BEFORE reading the state file (C3); non-atomic state-then-restart → two-phase committed-flag + roll-back on non-ok refresh (M1/M3); concurrent requestChange lost-update → per-topic serialization lock (M2); refresh is platform-bound-only → scope + honest unbound degradation (M2-r2); fail-safe-to-full-config was fail-DANGEROUS for Bounded Blast Radius → fall back to lean baseline not full config (M6); DEFAULT enabled:false is the dev-agent-gate anti-pattern → resolveDevAgentGate + ConfigDefaults omits enabled (M1-r2); state file outlives topic reintroducing the rejected static-profile mode → idle-offload IS reconciliation + TTL re-seed (M7); migrateClaudeMd missing → added (M4-r2); sweep proc→topic→server-name mapping + heavy-signature coverage specified (M5). MINOR folded: unique per-restart config path, per-topic framework gate, restart-storm bound cited, mid-tool-use re-check at kill time. Internal-only convergence (no cross-model codex reviewer this round) — noted honestly. The pure cores (commit 1fbf13bbb) were unaffected; all fixes are in the wiring design."
approved: true
approved-by: Justin
approved-via: "Telegram topic 28130 (2026-06-26/27): explicit 24h autonomous-mode directive whose Task 4 IS this feature ('better Usage and management of MCP servers ... load them dynamically as needed ... Playwright MAY stay default ... everything else dynamic'), plus 'you have my preapproval for any decisions need here', plus two rounds of direct design steer — the static model was rejected ('How can we possibly know what MCP servers a topic is gonna need when the session launches ... we need to be able to change this mid session even if that requires a session restart') and the final trigger/baseline model was specified ('start genuinely lean ... the agent ... perform the dynamic loading and unloading and restarting ... if they are preapproved ... otherwise ... ask the user'). Approval recorded per the A2A-DURABLE-DELIVERY-SPEC autonomous-directive precedent: the operator's explicit autonomous directive + the spec being its faithful embodiment IS the approval. Internal-only convergence noted honestly."
eli16-overview: DYNAMIC-MCP-LIFECYCLE-SPEC.eli16.md
commitment: CMT-1813
---

# Spec — Dynamic MCP Lifecycle

## Problem

Claude Code fixes a session's MCP server set **at launch** (it reads the
project's `.mcp.json`, or an explicit `--mcp-config`). There is no hot-reload:
changing a session's MCP set requires relaunching the session with a different
`--mcp-config` (a `claude --resume` preserves the conversation). MCP servers are
heavy and mostly idle — Playwright spawns a full Chromium, some bridges run
Electron — and idle copies stacked across long-lived sessions were a dominant
share of the process footprint behind the 2026-06-26 kernel panic
(`os_refcnt: overflow` — a kernel-object exhaustion).

The static per-topic profile model (#1292) was **rejected** by the operator
(2026-06-27): a topic's MCP needs are NOT knowable at launch and must be
changeable **mid-session**. Any pre-set per-topic list is either too broad
(heavy servers idle anyway) or wrong the moment the topic does something new.
The need is only knowable **at point-of-use** → the decision must be dynamic.

## Operator decision (2026-06-27, verbatim intent)

1. **Genuinely lean baseline.** A session launches with only the light,
   always-on bridge(s) (e.g. `threadline`, a cheap stdio relay). Heavy servers
   (Playwright/Chromium) are NOT warm by default — they load on demand.
2. **Load-on-demand, gated by preapproval.** When the agent determines
   mid-session that it needs a heavy server:
   - **Preapproved** (an autonomous session IS preapproved for reversible
     decisions + restarts) → the agent loads the server, restarts its own
     session `--resume`, and continues. No human in the loop.
   - **Not preapproved** → the agent ASKS the operator first ("I need X — ready
     for a quick restart? the conversation is preserved") and waits for a yes.
3. **Idle-offload.** A heavy server idle under a live session past a window
   (~30 min default) is dropped (restart `--resume` without it); it reloads on
   next use. Compatible with autonomous sessions.

## Design

### The pure cores (DONE — commit 1fbf13bbb, shipped dark)

- `src/core/dynamicMcpConfig.ts`
  - `resolveBaselineServers(allServerNames, cfg): string[] | null` — the lean
    launch set. `null` ⇒ full `.mcp.json` (default-no-op: feature off, or
    enabled without an explicit `keepWarm` trim).
  - `mutateLoadedServers(current, allServerNames, op): McpMutateResult` —
    mechanical load/offload with validation (unknown-server rejected;
    already-loaded / not-loaded no-ops). Never mutates inputs.
  - `filterMcpConfig(full, allowed): McpJson` — filter `.mcp.json` to a server
    set, preserving other top-level fields.
- `src/monitoring/mcpIdleLiveOffload.ts`
  - `decideIdleLiveOffload(input, cfg): IdleLiveOffloadDecision` — fail-CLOSED
    eligibility: keep on any uncertainty (feature off, owner not live, light
    signature, keep-warm, mid-tool-use true OR unknown, idle window not crossed).

> The design below folds an adversarial 2-reviewer convergence pass
> (2026-06-27). The reviewers found two CRITICAL design errors in the first
> draft — the offload-leak (C1) and the approval-self-certification hole (C4) —
> plus rollback-strands, non-atomic state/restart, and several integration gaps.
> All are folded here; the convergence-detail frontmatter records them.

### The loaded-set state file (source of truth for what a session launches with)

Per-topic runtime state at
`<projectDir>/.instar/state/mcp-loaded/<topicId>.json`:
```json
{ "servers": ["threadline"], "committed": true, "updatedAt": "ISO", "reason": "baseline|load|offload" }
```
- **Seeded** on first interactive spawn from `resolveBaselineServers` (config).
- **`buildSessionMcpFlags(topicId, framework)` resolution ORDER is load-bearing**
  (fold C3 — a wrong order strands sessions after rollback):
  1. **enabled-gate** — if `resolveDevAgentGate(cfg.dynamicMcp?.enabled, config)`
     is false ⇒ return `[]` (full `.mcp.json`). This is checked FIRST, BEFORE any
     state file, so disabling the feature is a clean no-op even for a topic whose
     state file says `["threadline"]` (it would otherwise relaunch trimmed +
     stranded). 
  2. **framework-gate** — if the topic's framework ≠ `claude-code` ⇒ `[]`
     (fold m2: framework is per-spawn; resolve THIS topic's framework).
  3. **state file** — if a `committed:true` state file exists ⇒ filter `.mcp.json`
     to its `servers` and return the flags. (An un-`committed` file is IGNORED —
     see two-phase commit below.)
  4. **baseline** — else `resolveBaselineServers(names, cfg)`; non-null ⇒ flags.
  5. **`[]`** — else full `.mcp.json`.
- **Fail direction (fold M6 — fail-safe must not be fail-DANGEROUS for the parent
  principle):** when the CONFIG is readable but the STATE FILE is unreadable, fall
  back to the **lean baseline** (`resolveBaselineServers`), NOT the full config —
  a transient state-dir error across many sessions must not relaunch every heavy
  server warm and re-create the exhaustion condition. Only when even the config is
  unreadable do we fall back to `[]` (full `.mcp.json`). Tool-availability is still
  preserved (baseline always includes the light bridge); blast-radius stays bounded.

**Concrete wiring sites (fold C1-reviewer2 — the hook does NOT exist yet):** the
interactive launch is built by `claudeCodeBuilder` in
`src/core/frameworkSessionLaunch.ts` (~L215-272), which today has ZERO MCP
awareness. Wiring = (a) add an `mcpFlags?: string[]` field to
`InteractiveLaunchOptions` and emit it in `claudeCodeBuilder`; (b) in
`SessionManager.spawnInteractiveSession` (~L3731) resolve
`buildSessionMcpFlags(topicId, framework)` and pass it into `buildInteractiveLaunch`.
(This mirrors the #1292 `buildSessionMcpProfileFlags` pattern, which lives on a
sibling branch and is NOT merged here.)

### The mutate + restart driver (`DynamicMcpManager`) — two-phase, serialized

`requestChange(topicId, op, actor)` runs under a **per-topic serialization lock**
(fold M2-reviewer1 — concurrent load/offload would lose-update the state file):
1. Acquire the per-topic lock (queue; a second concurrent request waits).
2. Read the current loaded set (committed state file, or baseline if none).
3. Read `.mcp.json` server names. `mutateLoadedServers(current, names, op)`.
   If `!changed` ⇒ release lock, return the no-op outcome (already-loaded /
   not-loaded / unknown-server) — NO restart.
4. **Authorization gate** (see below). Not authorized ⇒ return
   `{ status: 'needs-approval', nonce }` and do NOT touch state/restart.
5. **For an offload: CAPTURE the heavy MCP child PIDs** for this session NOW
   (via the reaper's `tmuxPaneMap`/signature scan), before the kill — they will
   be reparented orphans after the restart and must be reaped by captured PID
   (fold C1: see "Offload actually reclaims" below).
6. Write the new state file with `committed:TRUE` (atomic temp+rename), and the
   new filtered `--mcp-config` to a UNIQUE per-restart path (fold m3 — never
   overwrite the file the LIVE old session launched from).
   **COMMIT-BEFORE-RESTART correction (live-test 2026-06-27):** the spawn builder
   reads the COMMITTED loaded-set, so the new set must be committed BEFORE the
   restart, or the restart's own respawn reads the prior committed state and spawns
   from baseline. The original M1/M3 fold committed AFTER the restart (un-committed
   first) to make a failed restart leave the old set — but that ALSO made the
   *successful* restart's respawn ignore the un-committed new set, so a LOAD was a
   no-op on its own restart (it only took effect on a SUBSEQUENT restart), directly
   contradicting "respawnSessionForTopic ... DOES pick up the new flags" below.
   Committing before the restart makes the respawn deterministically pick up the new
   set; the failure-safety is preserved by the rollback in step 7.
7. Trigger the restart (see "Restart" below). On a **non-ok** restart, roll the
   state file back to the PRIOR committed set (fold M1/M3): `refreshSession` returns
   ok ⟺ the new session is up, so a non-ok restart means no new session came up and
   the next spawn reads the rolled-back prior set — no phantom unapproved change
   survives, the same safety the original committed-after design targeted.
8. For an offload, after the respawn is confirmed up, reap the captured orphan
   PIDs directly. Release the lock.

**Restart (fold C2 + M2-reviewer2 — scope + degradation honesty).** Reuse
`SessionRefresh.refreshSession` (kill + respawn `--resume`; `respawnSessionForTopic`
re-enters `spawnInteractiveSession`, so it DOES pick up the new flags — but ONLY
once the (a)+(b) wiring above lands). `refreshSession` only restarts
Telegram/Slack-bound sessions; for an UNBOUND/headless session it returns
`not_telegram_bound`. So load-on-demand/offload apply to platform-bound sessions
(which the autonomous topic sessions in scope here are); on an unbound session
`requestChange` returns `unsupported-unbound` (no-op, surfaced honestly), never a
silent failure. A non-`ok` `RefreshResult` (`rate_limited`, `refresh_in_progress`,
`session_not_found`) is surfaced to the caller AND rolls back step 6 (re-asserts the
PRIOR set as `committed:true`, so the next spawn reads the old set) — it is never
swallowed.

**Offload actually reclaims (fold C1 — THE critical fix).** The reaper's own
header is explicit: killing a session's pid does NOT cascade to MCP children —
they reparent to launchd and survive for days. So "the child dies with the old
session" was FALSE; offload-via-restart alone would LEAK one Chromium per offload
and make the footprint worse. The fix: the driver captures the heavy child PIDs
BEFORE the kill (step 5) and, after the new session is confirmed up WITHOUT that
server, directly kills those captured PIDs (step 8). This is a targeted kill of a
**provably-dead** session's orphan, identified by captured PID — it does NOT
invert the `McpProcessReaper` "never touch a LIVE session's proc" invariant (the
old session is gone). The generic reaper (2h-min-age orphan sweep) remains the
belt-and-suspenders backstop; the driver does not depend on it being enabled.

### Authorization gate (fold C4 + M4 — Know Your Principal)

The agent is the ONLY caller of `/mcp/*` (shared Bearer token injected into every
spawn), so it could self-certify `approved:true`. The gate therefore CANNOT trust
an agent-supplied approval flag. Model:
- `isPreapproved(topicId)` is true ONLY when the topic has a **live autonomous
  run** per the REAL autonomous-session registry (`GET /autonomous/sessions`
  authority, fail-CLOSED on read error — never bare file-existence), OR the topic
  is in the explicit `dynamicMcp.preapprovedTopics` standing grant. Preapproval is
  **re-checked atomically at kill time** (inside the lock), so a topic that flipped
  autonomous→interactive cannot be restarted under a stale grant (fold M4) — most
  importantly the idle sweep can NEVER autonomously restart a now-interactive human
  session.
- When NOT preapproved, `requestChange` returns `needs-approval` + a SERVER-minted
  one-time `nonce` (persisted server-side, bound to the exact `(topicId, kind,
  server)`). The agent surfaces the server-authored prompt conversationally. The
  operator's approval must arrive on an **operator-authenticated channel** — a
  dashboard-PIN action OR a MessageSentinel-intercepted "yes" bound to the
  Telegram user-id of the verified operator — and the route matches the nonce.
  **An agent forwarding `approved:true` over the shared Bearer NEVER satisfies the
  gate** (Agent Proposes, Operator Approves; the authority text is server-authored
  from the structured request, never agent free-text). The nonce is single-use.

### Idle-offload sweep (dark + dry-run first)

A periodic sweep enumerates heavy live-session MCP procs and maps each to a
`(topicId, .mcp.json server name)` (fold M5-reviewer2 — the mappings are
non-trivial and MUST be specified): the reaper attributes a proc to its owning
tmux session (`tmuxPaneMap`/`owningSession`); the sweep then maps tmux-session →
topicId (`telegram.getTopicForSession`) and `signatureId → .mcp.json name` via a
small registry (`'playwright-mcp' → 'playwright'`; the Electron bridge cited in
the Problem statement needs its signature + name added to `HEAVY_MCP_SIGNATURE_IDS`
before it can be offloaded — TODO noted, not silently uncovered). It tracks a
per-proc continuous-idle clock and calls `decideIdleLiveOffload`. An eligible proc
calls `requestChange(topic, {offload, server})` — itself authorization-gated
(an idle-offload on a non-preapproved interactive session surfaces an ASK, never a
silent restart). **Mid-tool-use is re-checked atomically immediately before the
kill** (fold M3-reviewer1 — the sweep-time `false` can go stale; abort the offload
if any tool-use is observed in the in-flight window). Ships dark + `dryRun:true`
(logs the intended offload without restarting).

### State reconciliation (fold M7 — don't reintroduce the static-profile failure)

The loaded-set state file is NOT write-once: a server loaded once must not stay
warm forever (that is exactly the static-profile model the operator rejected). The
sweep's idle-offload IS the reconciliation for heavy servers (they drop after the
idle window). Additionally: a `committed` state file older than a TTL with no
recent activity is re-seeded from the lean baseline on next spawn; a state file
naming a server no longer in `.mcp.json` drops it (via `filterMcpConfig`) and logs
a one-line warning rather than silently vanishing.

### API surface (Bearer-gated; dev-agent-gated dark)

- `GET  /mcp/session/:topicId` — the current loaded set + `preapproved` + the
  framework (Registry First: read it, never guess).
- `POST /mcp/load   { topicId, server }` — request a load (authorization-gated).
- `POST /mcp/offload { topicId, server }` — request an offload.
- All routes 503 when `resolveDevAgentGate(cfg.dynamicMcp?.enabled, config)` is
  false (fold M1-reviewer2 — NOT a hardcoded `enabled:false` check; the routes +
  sweep resolve through `resolveDevAgentGate` and `ConfigDefaults` OMITS `enabled`
  so the dev agent dogfoods live while the fleet stays dark; the pure core's
  `DEFAULT_DYNAMIC_MCP_CONFIG.enabled:false` is only the library default).

## Safety

- **Dev-agent-gated dark.** Routes 503 + spawn builder returns `[]` (full
  `.mcp.json`) + sweep inert on the fleet; live on a development agent. A
  single-server or no-`.mcp.json` agent is a strict no-op.
- **Fail toward bounded blast radius, not just tool-availability.** State-file
  unreadable but config readable ⇒ lean baseline (NOT full config); only a config
  read failure ⇒ `[]`. Tool-availability preserved AND the panic condition is not
  re-created on a transient error (fold M6).
- **Commit-before-restart + serialized + atomic-checked restart.** State is
  committed BEFORE the restart so the respawn deterministically reads the new set
  (live-test correction — committing AFTER left a LOAD a no-op on its own restart);
  concurrent requests serialize per-topic; a non-`ok` refresh rolls back to the
  prior committed set and is surfaced (fold M1/M2/M3).
- **Authority is server-held.** A restart happens only for a re-checked-live
  preapproved topic OR a nonce-matched operator-authenticated approval; an
  agent-supplied `approved:true` is structurally insufficient (fold C4).
- **Offload genuinely reclaims.** Captured-PID reap of the dead session's orphan
  (fold C1) — not a hope that the child "dies with the session" (it doesn't).
- **Restart-storm bound** = `SessionRefresh`'s rolling `maxPerWindow` rate guard +
  the 30-min idle window; a flapping load/offload hits the cap and rolls back
  rather than storming (fold m3-reviewer2).
- **Idempotent / no-op safe.** A redundant load/offload is a no-op with no
  restart.

## Framework generality

The MCP `--mcp-config` / `--strict-mcp-config` mechanism is **Claude-Code
specific**. codex-cli configures MCP via `mcp_servers` in its config.toml;
gemini-cli differs again. The baseline-at-spawn injection, the mutate+restart
driver, and the routes are scoped per-session to the **claude-code framework**
(resolved from THAT topic's framework, fold m2): on other frameworks
`buildSessionMcpFlags` returns `[]` and `requestChange` returns
`unsupported-framework` (no restart). Stated in the wiring commit's side-effects
artifact per the Framework-Agnostic standard.

## Testing (all three tiers)

- **Unit (DONE, 28 tests):** baseline resolution both sides; load/offload
  mutation each branch; idle-offload each gate both ways + fail-closed on
  unknown.
- **Unit (wiring):** `buildSessionMcpFlags` resolution ORDER (enabled-gate →
  framework-gate → committed-state-file → baseline → `[]`); the disabled-gate
  short-circuits BEFORE reading a state file (C3 regression); state-file
  unreadable + config readable ⇒ lean baseline, not full config (M6 regression);
  `isPreapproved` both sides reading the real registry fail-closed; the driver
  no-ops when `!changed`; an un-`committed` state file is ignored by the builder
  (two-phase, M1); a non-`ok` refresh rolls back the state write (M3); an
  agent-supplied `approved:true` over Bearer does NOT satisfy the gate (C4); the
  captured-PID reap targets only the captured orphan pids (C1).
- **Integration:** the three `/mcp/*` routes — 503 when dev-gate-dark, 200 +
  correct shape when enabled, Bearer-gated, a non-preapproved load returns
  `needs-approval` + a server-minted nonce (no restart side-effect), a
  nonce-matched operator-authenticated approval schedules a restart (mocked
  refresh), a preapproved (live-autonomous) topic schedules without a nonce.
- **E2E:** boot the real AgentServer with the feature enabled; assert
  `GET /mcp/session/:topic` is alive (200, real shape), read-only routes reject
  POST appropriately, and a disabled boot 503-stubs every route.

## Rollout

Graduated-feature ladder: ships dark (`enabled:false`) + the sweep `dryRun:true`.
Dogfood on this development agent first (baseline lean = `keepWarm:['threadline']`)
behind the dev-agent gate; fleet stays dark. Config: `.instar/config.json` →
`dynamicMcp` (`enabled`, `keepWarm`, `idleOffloadMs`, `preapprovedTopics`,
`sweep:{enabled,dryRun,intervalMs}`).

## Agent awareness + migration (parity for existing agents — fold M4-reviewer2)

- `generateClaudeMd` (new agents) gets a "Dynamic MCP Lifecycle" capability
  section (routes + the load-on-demand/preapproval/idle-offload proactive
  triggers).
- **`migrateClaudeMd`** in `PostUpdateMigrator` adds that SAME section to EXISTING
  agents with a content-sniffing guard (Migration Parity Standard #3 — without it
  deployed agents never surface the capability, the gap the reviewer flagged).
- `migrateConfig` adds the `dynamicMcp` defaults (existence-checked); `ConfigDefaults`
  OMITS `enabled` (dev-agent gate).
- `guardManifest` records the sweep guard so `GET /guards` renders it.
