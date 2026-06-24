---
title: Mesh Coherence — Live-State Honesty
slug: mesh-coherence-live-state-honesty
author: echo
date: 2026-06-24
status: draft
parent-principle: "Signal vs. Authority"
parent-principle-fit: "The multi-machine config-coherence checker emits advisory WARNINGS, never a boot reject — it is pure Signal, the operator is the Authority. This spec keeps it strictly signal-only while making the signal HONEST: today it reads config and reports 'all clear' even when the live mesh state contradicts the config (a flip-without-restart, or a half-activated boot). An advisory that lies is worse than silence. We make the warning live-state-aware so the signal it raises is true."
eli16-overview: mesh-coherence-live-state-honesty.eli16.md
lessons-engaged:
  - "Signal vs Authority (docs/signal-vs-authority.md) — the coherence check is a SIGNAL. It must never block boot; this spec preserves that and only widens what it can truthfully observe."
  - "Verify live state, don't infer from config (memory: 'updater says applied but disk is stale') — a recorded/intended config value can diverge from the running process. The same class of bug: config says X, the live process is doing Y. The fix is to read the live signal (the advertised mesh endpoints / the resolved bind), not the config alone."
  - "Don't build for a non-problem (memory: 'single-agent model → no multi-tenant defenses') — scope is kept TIGHT: two honesty fixes to one pure function, one of them resurrecting a check that was always-skipped because it validated the wrong (never-populated) key."
  - "Near-Silent Notifications / No-Deferrals (docs/STANDARDS-REGISTRY.md) — a check that re-logs the same true line on every tick is the repeated-true-line anti-pattern. This spec does NOT defer the fix: it emits TRANSITION-ONLY (log when the divergence set changes) with a LEVEL-TRIGGERED reset, plus a per-feature metric so the dev soak is gradeable."
  - "Observable Intelligence (docs/specs/observable-intelligence.md) — a background check that fires silently is unaccountable. The periodic check records a per-feature metric (fired/noop) through the existing FeatureMetricsRecorder funnel."
review-convergence: "2026-06-24T13:27:41.949Z"
review-iterations: 3
review-completed-at: "2026-06-24T13:27:41.949Z"
review-report: "docs/specs/reports/mesh-coherence-live-state-honesty-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (standing operator pre-authorization, topic 27515 — Justin's 2026-06-22 mandate: pre-approval for specs/decisions in this autonomous mesh run; ships dark behind monitoring.meshCoherenceLiveCheck.enabled). Tier 2; disclosed in PR body + cadence."
---

# Mesh Coherence — Live-State Honesty

## Problem statement

`checkMultiMachineConfigCoherence` (`src/core/configCoherence.ts:34-69`) is a startup
config-coherence checker for multi-machine agents. It is **signal-only**: it returns
advisory `ConfigCoherenceWarning[]` that the boot path logs (`src/commands/server.ts:3522`);
it never throws and never rejects boot. That design is correct and is preserved here.

Two honesty gaps remain:

### Gap (b) — the verdict reads CONFIG ONLY, never live state

The "mesh-off-while-live-transfer" check (`configCoherence.ts:44-51`) reads
`mm.meshTransport?.enabled === false && transferLive` purely from the config block. It
never inspects the **actual** running mesh state — the resolved server bind host or the
advertised `meshEndpoints` in the registry self-entry. Two real divergences slip past it:

1. **Runtime flip without restart.** `meshTransport.enabled` is read once at boot to
   compute `meshBindActive` (`server.ts:18464`, the expression
   `coordinator.managers.identityManager.hasIdentity() && config.multiMachine?.meshTransport?.enabled !== false`),
   which is passed to `AgentServer` and consumed at the bind callsite (`AgentServer.ts:3469`,
   `resolveMeshBindHost({ configHost, meshBindActive, meshBindHostOverride })`,
   `MeshUrlAdvertiser.ts:223-233`) → the server binds `0.0.0.0` and
   `advertiseSelfMeshEndpointsNow` (`server.ts:240`) publishes the rope set. If an operator
   later edits config to `meshTransport.enabled:false` **without restarting**, the live
   process is still bound `0.0.0.0` and still advertising endpoints, while a fresh
   `checkMultiMachineConfigCoherence(config.multiMachine, …)` (re-reading the now-disabled
   config) would report "all clear." The operator who flips the switch and re-reads coherence
   is told the mesh is off when it is demonstrably still up.

2. **Half-activated boot.** The inverse: config says `meshTransport.enabled:true` but the
   live self-entry has **no** advertised `meshEndpoints` (advertisement failed, identity
   wasn't ready, or a restart is pending). Config-only coherence says "on," live state says
   "this machine is not currently advertising mesh endpoints in its self-entry — a (re)start
   may be needed to actually activate."

In both cases the operator gets a **false sense of safety** from a check whose entire job
is to surface incoherent mesh state.

### Gap (c) — the priority check validates a key that is NEVER populated

The mesh-rope priority check (`configCoherence.ts:56-65`) validates
`mm.meshTransport?.priorities` — a `Record<string, number>` dict (`configCoherence.ts:23`).
But **that dict is never populated** by config or by type. The shipped config and the
canonical type define **flat** keys instead:

- `priorityTailscale: 10`, `priorityLan: 20`, `priorityCloudflare: 30`
  (`src/config/ConfigDefaults.ts:864-866`; typed at `src/core/types.ts:2176-2178`).

The canonical `MeshTransportConfig` (`types.ts:2170-2191`) has **no `priorities` field at
all** — the dict exists ONLY in the local `MultiMachineLike` shadow-interface
(`configCoherence.ts:23`). So the existing `.priorities`-dict check is **dead code** —
always skipped (guarded by `pri && typeof pri === 'object'`, and `pri` is always
`undefined`). A real operator mistake (e.g. `priorityLan: 10` colliding with
`priorityTailscale: 10`, or a negative value) sails through unwarned, and rope selection
becomes nondeterministic with no signal.

The canonical contract is documented at `types.ts:2175`: *"Endpoint priorities (lower =
preferred, Decision 2). Defaults 10/20/30. Distinct positive ints."* — the **distinct
positive integers** invariant is exactly what Fix (c) enforces, on the REAL flat keys.

---

## Out of scope (explicitly dropped)

- **(a) "server binds 127.0.0.1 → mesh inert."** RESOLVED by v1.3.652: the bind is
  correctly conditioned on `meshTransport.enabled` via `resolveMeshBindHost`
  (`MeshUrlAdvertiser.ts:223-233`, default `meshBindActive ? '0.0.0.0' : '127.0.0.1'`).
  The only residual is the **post-boot flip** case, which is exactly what Gap (b)
  covers — no separate fix.

- **(d) "tunnel.enabled=false → only the LAN rope."** WRONG / disproven. `computeSelfMeshEndpoints`
  (`MeshUrlAdvertiser.ts:185-203`) computes the **tailscale** rope independently of the
  tunnel — `inputs.tailscaleEnabled !== false && inputs.tailscaleIp` (lines 193-195). Live
  evidence shows `meshEndpoints=[tailscale, lan]` with `tunnel.enabled:false` and a working
  direct Tailscale reach to the peer. The tunnel only governs the **cloudflare** rope (lines
  199-201). No fix.

- **A structured health/status surface** (`lastAdvertiseAttemptAt` / `lastAdvertiseError`, a
  severity + last-seen view, on a `/threadline/health`-style route) — OUT OF SCOPE BY DESIGN: a
  structured health surface is a SEPARATE feature, NOT in-scope work this spec postpones; this
  spec deliberately adds no new route (R2-M6). Rationale: the operator workflow this spec serves — "flip the switch, re-read
  coherence, see whether the live mesh matches" — is fully served by the two surfaces already
  wired: the yellow log line (the existing `checkMultiMachineConfigCoherence` surface) and the
  per-feature `mesh-coherence-live` metric in `/metrics/features` (the dev-soak grading signal,
  M1). A structured health surface with severity + last-seen is a strictly-additive future
  layer that would not change any verdict this spec produces, so building it now would be
  scope creep; it stays out of scope deliberately, not by omission.

---

## Proposed design

Both fixes are **additive** to the existing pure config checks. The existing checks stay
intact; nothing is removed EXCEPT the dead `.priorities`-dict check, which Fix (c) deletes
(it validated a key that no type or default ever populates — see Decision #4).

### Fix (c) — validate the REAL flat priority keys (configCoherence.ts:54-66)

**DROP** the dead `.priorities`-dict check and validate the real flat keys instead. The
dict was never "legacy/defensive" — it was a phantom that existed only in the local
shadow-interface and never matched any shipped type or default, so keeping it is not
future-proofing, it is dead weight that misled this spec's own first draft. Fix (c) stays
inside the existing pure `checkMultiMachineConfigCoherence(mm, isMultiMachine)` signature —
no new argument, because the flat keys already live on `mm.meshTransport`.

**Retype `MultiMachineLike.meshTransport`** (`configCoherence.ts:23`) against the canonical
`MeshTransportConfig` so a phantom key cannot be reinvented — either import the canonical
type, or derive a `Pick` of the keys this checker reads. Concretely:

```ts
import type { MeshTransportConfig } from './types.js';

interface MultiMachineLike {
  // Read only the keys this checker validates; typed FROM the canonical config so a
  // phantom (e.g. the old `.priorities` dict) can't be reintroduced by a hand-edit.
  meshTransport?: Pick<
    MeshTransportConfig,
    'enabled' | 'priorityTailscale' | 'priorityLan' | 'priorityCloudflare' | 'bindHost'
  >;
  sessionPool?: { stage?: string; enabled?: boolean };
  leaseTtlMs?: number;
}
```

Replace the dict check with the flat-key check (same warning codes, same invariant
documented at `types.ts:2175`):

```ts
// 2) Mesh rope priorities must be DISTINCT positive integers (a tie makes rope selection
//    nondeterministic). The canonical contract — types.ts:2175 — ships the FLAT keys
//    priorityTailscale/Lan/Cloudflare (10/20/30); there is NO `.priorities` dict in the
//    type or in ConfigDefaults, so the dict check this replaces was always dead code.
const flat: Array<[string, number | undefined]> = [
  ['priorityTailscale', mm.meshTransport?.priorityTailscale],
  ['priorityLan', mm.meshTransport?.priorityLan],
  ['priorityCloudflare', mm.meshTransport?.priorityCloudflare],
];
const flatDefined = flat.filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
const flatBad = flatDefined.filter(([, v]) => !Number.isInteger(v) || v <= 0);
if (flatBad.length > 0) {
  warnings.push({
    code: 'mesh-priority-nonpositive',
    message: `multiMachine.meshTransport rope priorities must be positive integers; got ${JSON.stringify(Object.fromEntries(flatBad))}.`,
  });
}
const flatVals = flatDefined.map(([, v]) => v);
if (new Set(flatVals).size !== flatVals.length) {
  warnings.push({
    code: 'mesh-priority-collision',
    message: `multiMachine.meshTransport rope priorities have duplicate values (${JSON.stringify(Object.fromEntries(flatDefined))}) — rope selection is nondeterministic.`,
  });
}
```

Reuse the **existing** warning codes (`mesh-priority-nonpositive`, `mesh-priority-collision`)
so no new code-string lands and the boot logger needs no change. (Decision: reuse vs. new
codes resolved in Frontloaded Decisions.)

**Edge cases covered by `!Number.isInteger(v) || v <= 0`:** `NaN`, `Infinity`, floats, zero,
and negatives are all caught (`Number.isInteger` is false for `NaN`/`Infinity`/floats); a
single defined key cannot collide and is validated for positivity alone; all-undefined emits
nothing. **Merged-config contract (Decision #9):** `mm` is the RESOLVED/effective config
(ConfigDefaults already merged), so a user override of one key is validated against the
effective values of the others — an unmerged-config read would miss a `priorityLan:10`
colliding with the default `priorityTailscale:10`.

The warning stays advisory (the resolver applies its own selection over whatever priorities
it gets; a collision is operator-unintended and worth a signal, not a block).

### Fix (b) — make the mesh-state verdict live-state-aware (new periodic check)

The boot-time callsite (`server.ts:3522`) **cannot** read live endpoints: at that point
`getSelfMeshEndpoints` is not yet wired (it is assigned at `server.ts:4347` =
`() => idMgr.getMachineEndpoints(selfMachineId)`), and the self-entry endpoints are not
advertised until `advertiseSelfMeshEndpointsNow` runs later (`server.ts:12347`/`18993`).
So Fix (b) is NOT a boot-time check — it is a **separate, periodic, signal-only recheck**
that runs after the mesh is up and the self-getter exists.

Add a new pure function in `configCoherence.ts` that takes a **live-state snapshot** as an
explicit argument (keeping it unit-testable; same discipline as `resolveMeshBindHost` being
extracted pure). The function stays PURE — it returns warnings and decides nothing about
emission; the WIRING (below) decides whether to log/meter:

```ts
export interface MeshLiveState {
  /** The live resolved server bind host (e.g. '0.0.0.0' | '::' | '192.168.1.50' |
   *  '127.0.0.1'). PROCESS-LOCAL and OPERATOR-CONFIG-DERIVED (it comes from this machine's
   *  own resolveMeshBindHost over config.host / meshTransport.bindHost — NOT from peer data),
   *  so it is SAFE to render verbatim in a warning string (no peer-controlled value, no
   *  no-leak concern). b.1 treats it as "mesh is up" when it is ANY non-loopback host —
   *  NOT only the wildcards (see `boundWide` below). LIMITATION (R3, codex): this is the
   *  RESOLVED-INTENDED bind (the boot constant from resolveMeshBindHost over config.host /
   *  meshTransport.bindHost), NOT the post-bind actual listening address. If AgentServer ever
   *  fails the bind or normalizes it differently, b.1 reports intended-not-actual — acceptable
   *  for a boot-constant signal (the bind can't change without a restart); a future enhancement
   *  is an accepted limitation of a boot-constant signal (the bind cannot change without a
   *  restart). Reading AgentServer's real post-.listen() address is a SEPARATE concern, out of
   *  this spec's scope — not in-scope work it postpones. */
  boundHost?: string;
  /** The self-entry advertised endpoints, from idMgr.getMachineEndpoints(selfId).
   *  CONSUMED AS A BOOLEAN PRESENCE SIGNAL ONLY (length > 0) — never as an address,
   *  instruction, or authorization. See the security no-leak invariant below. */
  selfEndpoints?: import('./types.js').MeshEndpoint[];
  /**
   * Milliseconds since this process booted, from `process.uptime() * 1000` — a MONOTONIC
   * clock (immune to wall-clock jumps / NTP steps; no boot-timestamp capture needed). Gates
   * the b.2 "inert" warning so it cannot false-fire during the legitimate boot-warmup window
   * (tunnel.start() is non-fatal and retries in the background — endpoints are empty until
   * the first advertise lands). See Frontloaded Decision #8.
   */
  uptimeMs?: number;
}

/** Warmup grace: past this uptime, a config-on machine with no advertised endpoints warns.
 *  Comfortably past a healthy first advertise; tunable via the flag's `warmupGraceMs`. */
const MESH_WARMUP_GRACE_MS = 120_000; // 2 minutes

/**
 * Compare the CONFIG's intended mesh-transport state against the LIVE running state.
 * Signal-only — returns advisory warnings, never throws. Pure over (config, live).
 *
 * SECURITY / NO-LEAK INVARIANT (Decision #11): a warning string NEVER interpolates an
 * endpoint VALUE (host, IP, URL) from the peer-writable, git-synced self-entry. It
 * interpolates ONLY (i) integer COUNTS and (ii) the PROCESS-LOCAL bound-host string (which
 * the operator's own config produced — not peer data). `selfEndpoints` is consumed as a
 * boolean `length > 0` presence signal ONLY — never rendered, never treated as an address
 * or instruction. This keeps a hostile/garbage peer-written self-entry from steering the
 * warning text. (Unit-asserted — see Tests.)
 *
 * CONTRACT: `mm` is the RESOLVED/EFFECTIVE config (ConfigDefaults merged) — see Fix (c)'s
 * merged-config note and Decision #9.
 */
export function checkMeshLiveStateCoherence(
  mm: MultiMachineLike | undefined,
  isMultiMachine: boolean,
  live: MeshLiveState,
  // R2-M2: warmup grace is a PARAMETER (the wiring resolves it from the flag's `warmupGraceMs`
  // ?? the const and passes it in), so the tuning knob is actually READ. Defaults to the const
  // so unit tests and any caller omitting it keep the 2-min behavior.
  warmupGraceMs: number = MESH_WARMUP_GRACE_MS,
): ConfigCoherenceWarning[] {
  const warnings: ConfigCoherenceWarning[] = [];
  if (!mm || !isMultiMachine) return warnings;

  const configMeshOff = mm.meshTransport?.enabled === false;
  // (R2-M10) "wide" must mean NOT-LOOPBACK, not is-wildcard. resolveMeshBindHost can return a
  // SPECIFIC non-loopback host when the operator sets meshTransport.bindHost (e.g.
  // '192.168.1.50') or a non-loopback config.host — the live process is then mesh-UP on that
  // host even though boundHost is neither '0.0.0.0' nor '::'. Defining boundWide as is-wildcard
  // false-silenced b.1 on exactly the flip-without-restart case it exists to catch. So:
  // boundWide ≡ the bind is NOT loopback. (Mirrors the isLoopback predicate in
  // resolveMeshBindHost, MeshUrlAdvertiser.ts:229.) `undefined` (no bind observed) is treated
  // as loopback/inert → not wide. boundHost is PROCESS-LOCAL + operator-config-derived (it
  // cannot change without a restart, and carries no peer data), so it is the load-bearing
  // primary signal for b.1 AND is safe to render verbatim.
  const boundWide = !(
    live.boundHost === '127.0.0.1' ||
    live.boundHost === 'localhost' ||
    live.boundHost === '::1' ||
    live.boundHost === undefined
  );
  // selfEndpoints is peer-writable/git-synced — boolean presence ONLY, corroborating-only.
  const hasEndpoints = (live.selfEndpoints?.length ?? 0) > 0;

  // (b.1) Config says mesh OFF, but the PROCESS-LOCAL bind is still non-loopback (wide) → a
  //       runtime flip without a restart. PRIMARY signal = `boundWide` (process-local, can't
  //       change without a restart). `hasEndpoints` is CORROBORATING-only — a stale peer-written
  //       self-entry must NOT be able to fire this alone (the registry is a shared file).
  if (configMeshOff && boundWide) {
    const corroboration = hasEndpoints
      ? ` (and the self-entry still advertises ${live.selfEndpoints?.length ?? 0} mesh endpoint(s))`
      : '';
    warnings.push({
      code: 'mesh-config-off-but-live-on',
      message:
        'multiMachine.meshTransport.enabled=false in config, but the running server is still ' +
        // boundHost is operator-config-derived/process-local — safe to render the SPECIFIC
        // host (e.g. '0.0.0.0', '::', or '192.168.1.50'); NO peer endpoint value is leaked.
        `bound ${live.boundHost} (non-loopback)${corroboration} — the disable has ` +
        'not taken effect; a restart will apply it. (Advisory only — these codes carry no ' +
        'contract for automated remediation; the operator decides whether to restart.)',
    });
  }

  // (b.2) Config says mesh ON, but the live self-entry advertises NO ropes → this machine is
  //       not currently advertising mesh endpoints in its self-entry. Fire once uptime has
  //       passed the warmup grace, so a healthy boot's brief empty window does not false-fire,
  //       while a FIRST advertise that NEVER lands (dead/rate-limited tunnel, identity never
  //       ready) — the MOST important inert case — still warns shortly after boot (Decision #8).
  const warmupOver = (live.uptimeMs ?? 0) >= warmupGraceMs;
  if (!configMeshOff && warmupOver && !hasEndpoints) {
    warnings.push({
      code: 'mesh-config-on-but-live-inert',
      message:
        'multiMachine.meshTransport.enabled is on, but this machine is not currently ' +
        'advertising any mesh endpoints in its self-entry. Check identity readiness, the ' +
        'network interfaces (Tailscale/LAN), and the tunnel; restart only if endpoints are ' +
        'expected and absent. (Advisory only — no remediation contract; the operator decides.)',
    });
  }

  return warnings;
}
```

**Wiring (who calls it, with what live signal).** ⚠ **There is NO existing periodic
re-advertise timer.** `advertiseSelfMeshEndpointsNow` is called only at two *event-driven*
moments — the one-shot boot tunnel-start block (`server.ts:~18993`) and the SleepWake
tunnel-restart handler (`server.ts:~12347`) — neither is a `setInterval`. Hooking only those
two event-driven sites would miss the very divergence b.1 targets: a quiet runtime config
flip with no sleep/wake in between would never be rechecked.

**Resolved (Frontloaded Decision #1, cadence):** the check rides the **existing 30s
multi-machine periodic timer** — the `peerPresenceTimer` `setInterval(..., 30_000)` at
`server.ts:18192` (`unref()`'d at 18193; the puller at 18191; the only standing periodic
mesh tick, already created only on the multi-machine path, so a single-machine agent never
runs it). The check is appended to that callback. It does NOT create a new timer.

```ts
// ── OUTER function scope (server.ts ~4188, the SAME scope/indent as the existing
//    `let getSelfMeshEndpoints: …` declaration): declare meshResolvedBindHost as a `let`,
//    NOT a const inside the mesh-init try-block. The peerPresenceTimer closure (server.ts:18192)
//    reads it, and that closure lives at a far outer scope — a const declared inside the
//    mesh-init block (which closes ~server.ts:4566) would be block-scoped and UNREACHABLE from
//    the timer, exactly the bug that getSelfMeshEndpoints avoids by being let-declared here and
//    assigned inside the block. (R2-M9 / Decision #5.)
let meshResolvedBindHost: string | undefined;

// ── inside the mesh-init block (server.ts, alongside the `getSelfMeshEndpoints = …`
//    assignment near server.ts:4347): ASSIGN meshResolvedBindHost from the SAME meshBindActive
//    expression used at the AgentServer bind callsite (server.ts:18464 → AgentServer.ts:3469).
//    boundHost is a BOOT CONSTANT (the bind cannot change without a restart — which is exactly
//    the b.1 divergence), so a single boot-scope assignment is the live truth.
const meshBindActive =
  coordinator.managers.identityManager.hasIdentity() &&
  config.multiMachine?.meshTransport?.enabled !== false;
meshResolvedBindHost = resolveMeshBindHost({
  configHost: config.host,
  meshBindActive,
  meshBindHostOverride: config.multiMachine?.meshTransport?.bindHost,
});

// ── module-level (server.ts): transition-only emit state + failure-backoff state for the
//    live coherence check.
// `_meshCoherenceLastCodes`: per warning-code, the SET of codes emitted on the previous tick.
//   Emit a code's line ONLY when it transitions absent→present; LEVEL-TRIGGERED reset clears a
//   code when its divergence resolves, so a later recurrence logs fresh. Bounds the log to ONE
//   line per divergence episode instead of one-per-30s-tick (No-Unbounded-Loops / Near-Silent).
// `_meshCoherenceEmitCounts`: per warning-code re-emit tally for THIS process, enforcing the
//   optional `emitCap` ceiling (R2-M2 — the cap is actually READ in the emit loop below).
// `_meshCoherenceConsecFailures` / `_meshCoherenceTicksSinceAttempt`: capped consecutive-failure
//   backoff (R2-M1) so a sustained-corrupt registry does not re-throw-and-swallow every 30s.
// `_meshCoherenceFailing`: a healthy→failing LATCH (R3) so the 'error' metric is TRANSITION-GATED
//   (one row when the read STARTS failing, not one per attempt) — the same surface-the-state-change
//   shape as the divergence emission, so the error path is not the one unbounded notification.
let _meshCoherenceLastCodes = new Set<string>();
const _meshCoherenceEmitCounts = new Map<string, number>();
let _meshCoherenceConsecFailures = 0;
let _meshCoherenceTicksSinceAttempt = 0;
let _meshCoherenceFailing = false;
// No-Unbounded-Loops is satisfied — this IS a half-open breaker with all three brakes:
//   • BACKOFF: a read failure trips it to ≤1 attempt per MAX_BACKOFF_TICKS×30s ≈ 10 min.
//   • BREAKER: the `_meshCoherenceFailing` latch + backoff IS the breaker — failure trips it to a
//     degraded (backed-off) re-probe state; a successful read CLOSES it (auto-reset to full 30s).
//   • CAP: MAX_BACKOFF_TICKS floors the re-probe rate; the 'error' METRIC is transition-gated
//     (ONE row per failure episode, not per attempt), so neither CPU/IO nor metric rows grow.
// It is deliberately a HALF-OPEN (re-probing) breaker, NOT a hard-STOP one: a signal-only honesty
// observer that STOPS attempting goes BLIND if the registry recovers (or recovers into a real
// divergence the operator needs surfaced) — re-introducing the dishonesty this spec removes. So
// it re-probes at the floor, degrading gracefully and self-healing on the first successful read.
const MAX_BACKOFF_TICKS = 20;

// ── inside the existing peerPresenceTimer callback (server.ts:18192), AFTER pullOnce():
if (resolveDevAgentGate(config.monitoring?.meshCoherenceLiveCheck?.enabled, config)) {
  // R2-M1 backoff: after a failure, skip up to min(consecFailures, MAX_BACKOFF_TICKS) ticks
  // before retrying. SUCCESS resets the counters to 0 (auto-recover; stays signal-only).
  const backoffTicks = Math.min(_meshCoherenceConsecFailures, MAX_BACKOFF_TICKS);
  if (_meshCoherenceConsecFailures > 0 && _meshCoherenceTicksSinceAttempt < backoffTicks) {
    _meshCoherenceTicksSinceAttempt += 1;
  } else {
    _meshCoherenceTicksSinceAttempt = 0;
    // Resolve the tuning knobs (R2-M2 — both are actually READ). warmupGraceMs overrides the
    // b.2 grace; emitCap (if set) hard-caps re-emits per code per process.
    const warmupGraceMs =
      config.monitoring?.meshCoherenceLiveCheck?.warmupGraceMs ?? MESH_WARMUP_GRACE_MS;
    const emitCap = config.monitoring?.meshCoherenceLiveCheck?.emitCap; // undefined ⇒ unbounded
    const recorder = getFeatureMetricsRecorder();
    // THROW-SAFETY (Decision #11): the live registry read can throw on a corrupt / mid-write
    // registry file (MachineIdentity.loadRegistry → JSON.parse / fs errors). A signal-only
    // check must NEVER crash the tick. Wrap it; on any read failure emit an 'error' metric row
    // (Observable Intelligence — R2-M1), advance the backoff, and do NOT touch the transition
    // state (fail toward silence; an unreadable registry self-corrects).
    try {
      const live: MeshLiveState = {
        boundHost: meshResolvedBindHost,                  // boot constant (Decision #5)
        selfEndpoints: getSelfMeshEndpoints?.() ?? [],    // server.ts:4347 — registry self-entry
        uptimeMs: process.uptime() * 1000,                // MONOTONIC b.2 gate (Decision #8)
      };
      // warmupGraceMs is threaded into the pure fn (4th, optional, defaulting to the const).
      const warnings = checkMeshLiveStateCoherence(config.multiMachine, true, live, warmupGraceMs);
      const nowCodes = new Set(warnings.map((w) => w.code));
      let firedThisTick = false;
      for (const w of warnings) {
        if (!_meshCoherenceLastCodes.has(w.code)) {        // TRANSITION-ONLY (absent→present)
          const count = _meshCoherenceEmitCounts.get(w.code) ?? 0;
          if (emitCap === undefined || count < emitCap) {  // emitCap is READ here (R2-M2)
            console.log(pc.yellow(`  ⚠ mesh-live-coherence [${w.code}]: ${w.message}`));
            _meshCoherenceEmitCounts.set(w.code, count + 1);
            firedThisTick = true;
          }
        }
      }
      // Per-feature metric (Observable Intelligence): one event row per tick — 'fired' when a
      // NEW divergence was logged this tick, else 'noop'. Makes the dev soak gradeable.
      recorder?.record({ feature: 'mesh-coherence-live', kind: 'event', outcome: firedThisTick ? 'fired' : 'noop' });
      _meshCoherenceLastCodes = nowCodes;                  // LEVEL-TRIGGERED reset
      _meshCoherenceConsecFailures = 0;                    // SUCCESS resets the backoff (R2-M1)
      _meshCoherenceFailing = false;                       // R3: clear the latch — next failure re-emits ONE error row
    } catch {
      // Read/eval failure is non-fatal, non-emitting (no coherence warning from a read error),
      // and the divergence transition state is untouched (fail toward silence). It IS observable
      // but TRANSITION-GATED (R3): emit ONE 'error' row on the healthy→failing transition, not
      // every attempt — so a sustained-corrupt registry does not spew identical error rows (same
      // Observable-Intelligence shape as the divergence path: surface the STATE CHANGE, not every
      // tick). Recovery is already visible via the next successful tick's fired/noop row, so
      // suppressing mid-failure repeats loses nothing. (A registry corrupt from BOOT — never a
      // healthy tick — emits exactly one error row, then is quiet until it recovers; expected,
      // signal-only. The backoff still bounds the read attempts.)
      if (!_meshCoherenceFailing) {
        recorder?.record({ feature: 'mesh-coherence-live', kind: 'event', outcome: 'error' });
        _meshCoherenceFailing = true;
      }
      _meshCoherenceConsecFailures += 1;
    }
  }
}
```

The live signals are all available at that point:

- **`selfEndpoints`** — `getSelfMeshEndpoints()` (`server.ts:4347`), which reads
  `idMgr.getMachineEndpoints(selfMachineId)` → the registry self-entry `endpoints`
  (`MachineIdentity.ts:520`). The wiring `?? []` + the surrounding try/catch ensure a throw
  or undefined collapses to "no endpoints observed," never a crash. Consumed as boolean
  presence ONLY (no-leak invariant).
- **`boundHost`** — `meshResolvedBindHost`, the boot-scope assignment of
  `resolveMeshBindHost` (`MeshUrlAdvertiser.ts:223-233`) from the same `meshBindActive`
  expression the bind callsite uses (`AgentServer.ts:3469`, mirrored from `server.ts:18464`).
  It is declared `let meshResolvedBindHost: string | undefined` at OUTER function scope
  (~`server.ts:4188`, the same scope as `let getSelfMeshEndpoints`) and assigned inside the
  mesh-init block, so the `peerPresenceTimer` closure can reach it (R2-M9 / Decision #5). It is
  a boot constant — the bind cannot change without a restart, which is precisely the divergence
  b.1 detects. b.1's `boundWide` test treats it as mesh-UP whenever it is ANY non-loopback host
  (including a specific `meshTransport.bindHost` like `192.168.1.50`), NOT only the wildcards —
  R2-M10.
- **`uptimeMs`** — `process.uptime() * 1000`. The b.2 warmup gate: a first advertise that
  NEVER succeeds (dead tunnel / identity never ready) is the most important inert case, so
  after the warmup grace (`MESH_WARMUP_GRACE_MS`, 2 min) the never-advertised mesh warns.
  Using `process.uptime()` (monotonic) avoids both a captured-boot-timestamp variable and any
  wall-clock dependence (no `Date.now() - serverBootMs`).

The existing boot-time `checkMultiMachineConfigCoherence` call (`server.ts:3522`) is **left
exactly as-is** — config-only, at boot. Fix (b) is the new periodic layer beside it.

---

## Decision points touched

Both fixes produce only advisory **WARNINGS**:

- **Signal vs Authority.** Neither check ever blocks, rejects boot, throws, or mutates
  config/state. They append to a `ConfigCoherenceWarning[]` that a caller logs. The operator
  is the authority who decides whether to restart. The warning strings say so explicitly
  ("the operator decides"). This is identical to the existing checker's contract and is
  non-negotiable for this spec.
- **No new outbound surface required.** The warnings ride the existing log path
  (`console.log(pc.yellow(...))`). Surfacing them on the Attention queue or a route is an
  explicit non-goal here — that would add an authority/notify surface the existing checker
  deliberately does not have.
- **Observable Intelligence (shipped in this PR).** The periodic check records a
  per-feature event metric (`feature: 'mesh-coherence-live'`, `fired`/`noop`) through the
  existing `FeatureMetricsRecorder` funnel, so the dev soak is gradeable in `/metrics/features`
  with no new route. This is built here, not postponed.
- **Near-Silent Notifications (shipped in this PR).** The check emits
  **transition-only** (a code logs once when its divergence appears, then stays quiet until it
  resolves and recurs) with a **level-triggered reset** — bounding the log to one line per
  divergence episode instead of one-per-30s-tick. This directly resolves the repeated-true-line
  anti-pattern; the debounce is built here, with nothing postponed.
- **No automated remediation (the SRE alternative, declined).** A `mesh-config-off-but-live-on`
  divergence would, in an orchestrated/SRE setting, justify an automated restart. We
  deliberately do NOT do that: an auto-restart could mask an underlying flap, fight an
  operator who is mid-debug, or restart a machine the operator wants left running. The codes
  are advisory-only and carry NO contract for automated/remediation consumption (stated in the
  warning text). The check reports the divergence; the operator decides.

---

## Frontloaded Decisions

Every choice a builder would otherwise stop to ask, resolved:

1. **(b) mechanism — passing a live-state arg vs. periodic recheck vs. registry-self-entry
   read at the boot callsite.**
   **Resolved: a NEW periodic check (`checkMeshLiveStateCoherence`) that takes a live-state
   snapshot as an explicit argument.**
   - Why not extend the boot callsite (`server.ts:3522`)? Because at boot the live signals
     do not exist yet — `getSelfMeshEndpoints` is wired at `server.ts:4347` and endpoints
     are not advertised until the boot tunnel-start block (`server.ts:~18993`). A boot-time
     live read would always see "no endpoints" and false-fire.
   - **The concrete cadence is the existing 30s `peerPresenceTimer` (`server.ts:18192`)** —
     the only standing periodic mesh tick. There is no pre-existing periodic *re-advertise*
     timer to ride (`advertiseSelfMeshEndpointsNow` is event-driven only) — see the Wiring
     section.
   - Why an explicit `MeshLiveState` arg, not reading the registry inside the function?
     Keeps the function **pure and unit-testable** — the same lesson `resolveMeshBindHost`
     encodes ("extracted as a pure function precisely because the original inline version was
     untestable," `MeshUrlAdvertiser.ts:219-221`). The wiring passes the real registry read
     in; tests pass a literal snapshot.

2. **Does Fix (b) ride a dark flag?**
   **Resolved: YES — gate the new PERIODIC check behind a dev-gated flag
   `monitoring.meshCoherenceLiveCheck`, OMITTED from `ConfigDefaults` so `resolveDevAgentGate`
   decides (LIVE on a development agent, DARK on the fleet).**
   - Rationale: Fix (c) is a pure, additive improvement to an *existing* boot-time warning —
     it ships **unflagged** (no new background work, no new cadence, no behavior change beyond
     a more honest warning string on the same log line). But Fix (b) introduces a **new
     periodic evaluation** on a hot-ish cadence. Per the project's Graduated Feature Rollout
     discipline, a new background check is dark-gated and reversible even when signal-only.
   - **Flag shape (NESTED, with sibling tuning fields)** — matches the `growthAnalyst.enabled`
     convention (`types.ts:5383`, `ConfigDefaults.ts:474`):
     `monitoring.meshCoherenceLiveCheck.enabled` (boolean), with siblings
     `warmupGraceMs?: number` and `emitCap?: number`. **Both siblings are WIRED, not decorative
     (R2-M2):** `warmupGraceMs` is resolved in the wiring (`?? MESH_WARMUP_GRACE_MS`) and threaded
     into `checkMeshLiveStateCoherence`'s 4th param (so the b.2 grace is actually overridable);
     `emitCap` is read in the transition-emit loop as a per-code-per-process re-emit ceiling
     (belt-and-suspenders over transition-only). See Decision #6 + the wiring block.
     The whole block is OMITTED from `ConfigDefaults` (the dev-gate convention —
     `resolveDevAgentGate` resolves it live-on-dev / dark-fleet). Resolve at the wiring
     callsite with `resolveDevAgentGate(config.monitoring?.meshCoherenceLiveCheck?.enabled, config)`
     — **the FIRST arg MUST be the nested `?.enabled` boolean, never the block object.** The
     real helper signature (`src/core/devAgentGate.ts:40`) is
     `resolveDevAgentGate(explicitEnabled: boolean | undefined, config) => explicitEnabled ?? !!config?.developmentAgent`
     (Decision #2 / R2-M3): a truthy object passed as `explicitEnabled` short-circuits the `??`
     and returns the object, which is truthy → the feature would be PERMANENTLY ON for EVERY
     agent including the fleet, defeating the dark-gate. Every real caller passes `?.enabled`.
   - **`types.ts` `MonitoringConfig` declaration (add, near the `growthAnalyst` block,
     `interface MonitoringConfig` at `types.ts:4206`):**
     ```ts
     /** Periodic mesh config-vs-live-state coherence check (signal-only log warnings).
      *  Dev-gated dark: `enabled` OMITTED ⇒ resolveDevAgentGate (live-on-dev / dark-fleet). */
     meshCoherenceLiveCheck?: {
       enabled?: boolean;
       /** Override MESH_WARMUP_GRACE_MS (default 120000) for the b.2 gate. */
       warmupGraceMs?: number;
       /** Hard ceiling on coherence lines logged per process (default: unbounded;
        *  transition-only already bounds normal operation). */
       emitCap?: number;
     };
     ```
   - **`migrateConfig`: NOT needed.** The flag is OMITTED from `ConfigDefaults` (the dev-gate
     convention), so there is nothing to backfill into an existing config — `resolveDevAgentGate`
     reads the absence directly. This is stated explicitly so a builder does not add a
     migration that would defeat the gate.
   - **`DEV_GATED_FEATURES` entry (required — all four fields, or the registry interface +
     wiring test fail at CI; configPath ends in `.enabled`):**
     ```ts
     {
       name: 'meshCoherenceLiveCheck',
       configPath: 'monitoring.meshCoherenceLiveCheck.enabled',
       description: 'Periodic mesh config-vs-live-state coherence check (signal-only log warnings; per-feature metric).',
       justification: 'Signal-only periodic log line; reads only own config + own registry self-entry (boolean presence) + own resolved bind host; no egress, no spend, no mutation, no destructive action — safe to soak live on a dev agent.',
     }
     ```
     **Required test:** the dev-gate **wiring test** (`tests/unit/devGatedFeatures-wiring.test.ts`)
     asserts this configPath resolves live-on-dev / dark-fleet against real `ConfigDefaults`.

3. **Reuse the existing priority warning codes, or mint new ones for the flat keys?**
   **Resolved: REUSE `mesh-priority-nonpositive` and `mesh-priority-collision`.** The flat-key
   check enforces the identical invariant as the old dict check; one code per failure class
   keeps the operator-facing vocabulary stable and avoids a new code-string (no boot-logger
   change, no capability-index churn).

4. **Keep the dead `.priorities`-dict check, or remove it?**
   **Resolved: REMOVE it.** It is dead code — the `priorities` dict exists in NO type
   (`MeshTransportConfig`, `types.ts:2170-2191`, has no such field) and NO default
   (`ConfigDefaults.ts:861-872` ships only the flat keys), so it is always `undefined` and the
   check is always skipped. It was never "legacy/defensive future-proofing" — it was a phantom
   in the local shadow-interface that misled this spec's own first draft. Fix (c) replaces it
   with the flat-key check and **retypes** `MultiMachineLike.meshTransport` against the
   canonical `MeshTransportConfig` so the phantom cannot be reinvented.

5. **Where does `boundHost` come from for the periodic check, and at what SCOPE is it declared?**
   **Resolved: compute `resolveMeshBindHost` ONCE during boot, from the SAME `meshBindActive`
   expression the bind callsite uses** (`server.ts:18464` builds it for `AgentServer`;
   `AgentServer.ts:3469` consumes it). The bind host is a boot constant (it cannot change
   without a restart), so a captured boot value is exactly the live truth — and a config that
   now says "off" while `meshResolvedBindHost` is non-loopback is precisely the b.1 divergence.
   (There is no boot-scope `boundHost` variable to reuse today — `AgentServer` computes `host`
   internally at its listen call — so the boot scope recomputes from the same inputs.)
   - **SCOPE (R2-M9, load-bearing):** declare it as
     `let meshResolvedBindHost: string | undefined` at **OUTER function scope** (~`server.ts:4188`,
     the SAME scope and indent as the existing `let getSelfMeshEndpoints: …` declaration), and
     ASSIGN it inside the mesh-init block (alongside the `getSelfMeshEndpoints = …` assignment
     near `server.ts:4347`). It must NOT be a `const` declared inside the mesh-init try-block:
     that block closes (~`server.ts:4566`), so a block-scoped const would be UNREACHABLE from
     the `peerPresenceTimer` closure at `server.ts:18192`. This mirrors exactly how
     `getSelfMeshEndpoints` is made reachable. The closure reads `meshResolvedBindHost` with an
     undefined-guard (it is `string | undefined`; `checkMeshLiveStateCoherence` treats an
     `undefined` `boundHost` as loopback/inert → b.1 does not fire on it).

6. **Does the periodic check de-duplicate / rate-limit its log output, and is the failure path
   observable + bounded?**
   **Resolved: YES on both — transition-only emit with a level-triggered reset PLUS a capped
   consecutive-failure backoff, all in the WIRING (not the pure function).**
   - *Transition-only emit:* a per-code in-memory `Set` (`_meshCoherenceLastCodes`) holds the
     previous tick's emitted codes; a code logs ONLY on absent→present transition, and clears
     when its divergence resolves (so a recurrence logs fresh). The pure
     `checkMeshLiveStateCoherence` stays pure — it returns the full warning set every tick and
     decides nothing about emission; the wiring decides. This bounds the log to one line per
     divergence episode (No-Deferrals / No-Unbounded-Loops / Near-Silent — built here in full).
   - *Keying by CODE only is intentional (R2-M4).* The transition set keys on the warning CODE,
     not on `(code, boundHost)` or `(code, endpoint-count)`. This is correct, not a gap:
     `boundHost` is a boot constant (it cannot change without a restart, and a restart resets
     all this in-memory state), so there is no in-process boundHost change to fold into the key;
     and the endpoint COUNT detail is already carried in the logged line itself, not the key.
     The thing a transition-keyed advisory tracks is the divergence CLASS — which is exactly the
     code — so a per-code key is the right granularity.
   - *`emitCap` (R2-M2 — actually WIRED):* the optional `emitCap` flag sibling is READ in the
     emit loop as a hard belt-and-suspenders ceiling on re-emits PER CODE PER PROCESS, tracked
     via `_meshCoherenceEmitCounts`. `undefined` ⇒ unbounded (transition-only already bounds
     normal operation). It is not dead config — the wiring consults it on every would-emit.
   - *Failure-path observability + backoff (R2-M1):* the live registry read can throw on a
     corrupt/mid-write registry. The catch (a) records a per-feature `outcome: 'error'` metric
     row (a valid `FeatureMetricsRecorder` outcome — Observable Intelligence on the failure
     path, not silent), and (b) drives a capped consecutive-failure backoff via module counters
     `_meshCoherenceConsecFailures` / `_meshCoherenceTicksSinceAttempt`: after a failure it
     skips up to `min(consecFailures, MAX_BACKOFF_TICKS ≈ 20)` ticks before retrying, so a
     30s-forever-failing read does not re-throw every tick. The cap means a sustained-corrupt
     registry still attempts (and emits an `error` row) ~every 10 min — bounded, never fully
     silent. A SUCCESSFUL tick resets `_meshCoherenceConsecFailures` to 0 (auto-recover; stays
     signal-only). The transition state is never touched on failure (fail toward silence).

7. **Multi-machine posture — does one machine's check speak for the mesh?**
   **Resolved: machine-local.** Each machine evaluates its OWN config against its OWN live
   bind/endpoints. No cross-machine fan-out, no pool-scope read. A divergence is a local
   property (this machine's config vs. this machine's running state), so the check is
   correctly scoped to self — consistent with the existing checker.

8. **What gates the b.2 boot-warmup false-fire, and why uptime (not a latch)?**
   **Resolved: a single MONOTONIC uptime gate, `uptimeMs >= MESH_WARMUP_GRACE_MS` (2 min),
   using `process.uptime() * 1000`. NO `firstAdvertiseDone` latch.** The earlier draft gated
   on a `firstAdvertiseDone` boolean flipped on the first successful advertise — but
   `advertiseSelfMeshEndpointsNow` returns `void` and swallows its errors (`server.ts:240`),
   so there is no reliable success signal to latch on, and a latch-only gate would create a
   WORSE bug: if the first advertise NEVER succeeds (dead/rate-limited tunnel, identity never
   ready) the latch stays `false` forever and the b.2 "inert" warning — the MOST important
   inert case — would be suppressed for the life of the process. The uptime gate needs no
   success signal: it suppresses the brief boot window before a healthy first advertise lands,
   and GUARANTEES a permanently-inert mesh still warns ~2 min after boot. `process.uptime()`
   is monotonic (immune to wall-clock jumps), so no boot-timestamp variable is needed. b.1
   needs no gate at all (a wide bind + config-off is unambiguous from the first tick).
   - *Endpoint-less mesh-on is an INTENTIONAL advisory, not a false positive (R2-M5).* Once past
     the warmup grace, a `meshTransport.enabled:true` machine that advertises ZERO ropes IS a
     real coherence signal worth one advisory line — the mesh literally cannot function with no
     ropes. We deliberately do NOT add interface-availability suppression (e.g. "stay silent if
     no Tailscale/LAN interface exists"): that would hide exactly the case the operator most
     needs surfaced (mesh asked-for but inert), and the signal is already transition-only +
     operator-ignorable. So b.2 firing on mesh-on-with-no-endpoints is by design.

9. **Is `mm` the resolved/effective config or a raw user block?**
   **Resolved: RESOLVED/effective config (ConfigDefaults already merged).** Both the existing
   boot callsite and the new periodic callsite pass the merged config, so a user override of
   one priority key is validated against the *effective* values of the others (otherwise a
   `priorityLan:10` colliding with the default `priorityTailscale:10` would slip through). The
   function documents this as a contract; it does not merge defaults itself.

10. **The b.2 "inert" message — does it prescribe "restart"?**
   **Resolved: NO — and it does not claim unreachability either.** An empty advertise can mean
   identity-not-ready, no usable interfaces, a transient advertise failure, OR the known case
   where the boot advertise is gated behind a successful `tunnel.start()` (`server.ts:251`,
   the early `return` when identity is missing or mesh is config-off) — so a machine with a
   live Tailscale/LAN rope but a dead/rate-limited tunnel may not advertise, yet a restart
   would NOT fix it. Prescribing "restart" would be a wrong remedy = a dishonest signal. The
   message states the LIVE FACT honestly — "this machine is not currently advertising any mesh
   endpoints in its self-entry" (NOT "the mesh is unreachable," which over-claims a peer-side
   verdict this machine cannot know) — and points at what to check (identity / interfaces /
   tunnel). The advertise-gated-on-tunnel behavior is a **pre-existing limitation surfaced,
   not fixed here** — fixing it is explicitly out of scope.

11. **Can the live registry read crash the periodic tick, and can peer data steer the
    warning?**
   **Resolved: NO to both.**
   - *Throw-safety:* the live read is wrapped in try/catch at the wiring callsite, and the
     function is documented "never throws." `getSelfMeshEndpoints()` → `getMachineEndpoints`
     → `loadRegistry()` can throw on a corrupt/mid-write registry (git-synced + atomically
     rewritten by peers). On any read/eval failure the wiring emits NOTHING (fail toward
     silence), does NOT touch the transition state, and the tick continues. **Required test:**
     `getSelfMeshEndpoints` throws → the tick logs no warning and does not crash.
   - *No-leak / no-injection:* `selfEndpoints` is the peer-writable, git-synced self-entry, so
     it is consumed as a boolean `length > 0` PRESENCE signal ONLY — never interpolated into a
     warning string, never treated as an address/instruction/authorization. b.1 fires on the
     PROCESS-LOCAL `boundWide` signal (primary); the self-entry is corroborating-only and
     cannot fire it alone. Warning strings interpolate only integer counts + the process-local
     bound-host (operator-config-derived). **Required test:** a self-entry containing a hostile
     string in `url`/`kind` produces a warning whose text contains NONE of that string (only
     the count + the local bound host).

---

## Multi-machine posture

Machine-local. `checkMultiMachineConfigCoherence` already runs once per machine at boot;
`checkMeshLiveStateCoherence` runs periodically on each machine, reading only that machine's
own config block, its own self-entry endpoints (`getMachineEndpoints(selfMachineId)`,
consumed as boolean presence only), and its own resolved bind host. There is no cross-machine
query and no pool-scope merge — each machine is the sole authority on whether its own config
and its own live mesh state agree. A single-machine agent is a strict no-op (the
`isMultiMachine` guard returns `[]`, and the `peerPresenceTimer` is only created on the
multi-machine path). The self-entry endpoint set is **untrusted, peer-writable, git-synced
data** — the no-leak invariant (Decision #11) treats it as a boolean presence signal and
never as an address or instruction.

---

## Tests

Three-tier coverage per the Testing Integrity Standard.

### Unit (`tests/unit/configCoherence.test.ts`, extend the existing file)

Fix (c) — flat priority-key validation (against the canonical flat keys):
- `priorityTailscale:10, priorityLan:10, priorityCloudflare:30` → `mesh-priority-collision`.
- `priorityTailscale:0` (non-positive) → `mesh-priority-nonpositive`.
- `priorityLan:-1` → `mesh-priority-nonpositive`.
- `priorityTailscale:1.5` (non-integer) → `mesh-priority-nonpositive`.
- `priorityTailscale:Infinity` (non-finite) → `mesh-priority-nonpositive`
  (`Number.isInteger(Infinity)===false`).
- `priorityTailscale:10, priorityLan:20, priorityCloudflare:30` (the shipped default) →
  **no** priority warning.
- Partial set (only `priorityLan:20` defined) → no warning (a single defined value can't
  collide and is positive).
- **Dead-code removal regression:** a config carrying an old-style `priorities` dict
  (`{ tailscale: 10, lan: 10 }`) produces **no** warning from the dict (the dict check is
  gone; only the flat keys are validated) — and TypeScript rejects the dict on the retyped
  `MultiMachineLike` (compile-time proof the phantom can't be reintroduced).

Fix (b) — live-state drift, BOTH directions (`checkMeshLiveStateCoherence`):
- config `meshTransport.enabled:false` + live `boundHost:'0.0.0.0'` →
  `mesh-config-off-but-live-on`.
- config `meshTransport.enabled:false` + live `boundHost:'::'` (IPv6 wildcard) →
  `mesh-config-off-but-live-on` (both wildcards are wide-bound).
- **bindHost-override flip (R2-M10 — the regression this finding guards):** config
  `meshTransport.enabled:false` (flipped without a restart) + live `boundHost:'192.168.1.50'`
  (a SPECIFIC non-loopback host from a `meshTransport.bindHost` override) →
  `mesh-config-off-but-live-on` MUST fire (boundWide is NOT-LOOPBACK, not is-wildcard — a
  specific non-loopback bind is still mesh-UP). The emitted message renders the specific host
  `192.168.1.50` (operator-config-derived, safe to show; still no peer endpoint value leaked).
- config `meshTransport.enabled:false` + live `boundHost:'127.0.0.1'`,
  `selfEndpoints:[{kind:'tailscale',...}]` (a STALE peer-written self-entry, but the bind is
  loopback) → **no** warning (b.1 fires on the PROCESS-LOCAL bind, not the corroborating
  self-entry — the self-entry alone must NOT fire it).
- config `meshTransport.enabled:false` + live `boundHost:'0.0.0.0'`,
  `selfEndpoints:[{...}]` → `mesh-config-off-but-live-on` with the corroboration clause present
  (counts only).
- config `meshTransport.enabled:false` + live `boundHost:'127.0.0.1'`, `selfEndpoints:[]`
  → **no** warning (the disable HAS taken effect).
- config `meshTransport.enabled:true` + live `selfEndpoints:[]`, **`uptimeMs` BELOW the grace
  (e.g. 5_000)** → **no** warning (boot-warmup suppression).
- config `meshTransport.enabled:true` + live `selfEndpoints:[]`, **`uptimeMs` PAST the grace
  (e.g. 130_000)** → `mesh-config-on-but-live-inert` (the permanent-failure case — a first
  advertise that never lands must NOT be suppressed forever).
- config `meshTransport.enabled:true` + live `selfEndpoints:[{...}]`, any `uptimeMs` →
  **no** warning (coherent: on and advertising).
- **warmupGraceMs param override (R2-M2):** config `meshTransport.enabled:true` + live
  `selfEndpoints:[]`, `uptimeMs:90_000`, called with `warmupGraceMs:60_000` →
  `mesh-config-on-but-live-inert` fires (90s ≥ the 60s override, even though it is BELOW the
  120s const default — proving the param is read, not the const); the same inputs with the
  param omitted → **no** warning (90s < 120s const). Proves the knob is live, not dead config.
- `isMultiMachine:false` → `[]` regardless of live state (single-machine no-op).
- `mm:undefined` → `[]` (never throws).
- **No-leak invariant (security assertion):** live
  `selfEndpoints:[{kind:'tailscale',url:'http://EVILHOST:9/INJECT<script>'}]` + config-off +
  bound wide → the emitted `mesh-config-off-but-live-on` message contains NONE of `EVILHOST`,
  `INJECT`, or `<script>` (only the integer count + the process-local bound host). The
  injection payload lives in `url` (a free `string`), NOT in `kind` — `kind` is the typed union
  `'tailscale' | 'lan' | 'cloudflare'`, so a hostile-string `kind` would not type-check; `url`
  is the realistic peer-controlled vector (R2-M7). Proves the self-entry is consumed as presence
  only.

### Integration (HTTP / log-surface + transition-only)

The existing checker has no route; its surface is the boot log. The integration test asserts
the **surfacing path**, not a route:
- Drive a periodic-tick harness with a config-vs-live divergence and assert the
  `mesh-live-coherence [<code>]: <message>` line is emitted (capture `console.log`), and that
  the tick completes (signal-only — no throw).
- **Transition-only:** drive the SAME divergence over THREE consecutive ticks → the line is
  logged exactly ONCE (ticks 2-3 are silent). Then resolve the divergence (one clean tick) and
  re-introduce it → the line logs AGAIN (level-triggered reset). Assert the per-feature metric
  records `fired` on the transition tick and `noop` on the steady-state ticks.
- Assert the dev-flag gate: with `monitoring.meshCoherenceLiveCheck` resolved DARK (fleet),
  the periodic check is a no-op and emits nothing; resolved LIVE (dev agent), the divergence
  line appears.
- **Sustained-failure observability + backoff (R2-M1):** stub `getSelfMeshEndpoints` to THROW
  every call, then drive many consecutive ticks → (i) the FIRST failing tick records a
  per-feature `outcome: 'error'` metric row and logs no warning and does not crash; (ii) the
  backoff engages — over a long run the number of `error` rows is BOUNDED to roughly one per
  `MAX_BACKOFF_TICKS` (≈ one per 10 min of ticks), NOT one per 30s tick; (iii) then make the
  stub succeed on a divergence → the backoff resets to 0 (`_meshCoherenceConsecFailures===0`)
  and the very next tick emits the divergence line + a `fired` metric (auto-recovery proven).
- **emitCap ceiling (R2-M2):** with `monitoring.meshCoherenceLiveCheck.emitCap:2` set, drive a
  divergence that resolves-and-recurs more than twice (each recurrence is a fresh transition) →
  the line for that code logs at most TWICE for the process lifetime (the 3rd+ recurrence is
  suppressed by the cap), proving `emitCap` is read, not dead.
- **Dev-gate wiring test** (`tests/unit/devGatedFeatures-wiring.test.ts`): assert the
  `monitoring.meshCoherenceLiveCheck` entry is registered in `DEV_GATED_FEATURES` with all
  four required fields and its configPath (`monitoring.meshCoherenceLiveCheck.enabled`)
  resolves live-on-dev / dark-fleet against real `ConfigDefaults`.

### E2E (boot-time wiring still fires)

- A production-path boot (mirroring `server.ts`) with a multi-machine identity asserts the
  **existing** boot-time `checkMultiMachineConfigCoherence` call (`server.ts:3522`) still
  runs and still logs its config-only warnings — proving Fix (c)'s change did not break boot.
- With the dev flag LIVE, assert the periodic `checkMeshLiveStateCoherence` is wired onto the
  existing 30s `peerPresenceTimer` callback (`server.ts:18192`; NOT a new timer, NOT the
  event-driven advertise sites) and that `getSelfMeshEndpoints` + the resolved
  `meshResolvedBindHost` are passed as real (non-null) live signals (wiring-integrity: the dep
  is not a no-op stub). Assert the live read is wrapped so a throwing `getSelfMeshEndpoints`
  cannot crash the tick (Decision #11), and that `uptimeMs` is sourced from `process.uptime()`.

---

## Open questions

*(none)*
