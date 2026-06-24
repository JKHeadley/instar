/**
 * Phase 2 #7 (multimachine-lease-poll-robustness audit) — startup config-coherence
 * checks. Surfaces incoherent multi-machine config combinations that silently
 * degrade behavior (the 2026-06-20 audit: meshTransport disabled while session
 * transfer is live left the pair on single-rope fragility under transfer load —
 * the worst-of-both state my morning band-aid created).
 *
 * SIGNAL only — these are WARNINGS, never a startup REJECT. A hard reject would
 * refuse fleet boot on a config the audit showed is the SHIPPED default in some
 * combinations (F-CLAMP1: default TTL 60s < tick 120s would itself trip a naive
 * invariant). So the checker returns warnings the caller logs (+ optionally an
 * Attention item); it never throws.
 *
 * Pure + deterministic → fully unit-testable.
 */

import type { MeshTransportConfig } from './types.js';

export interface ConfigCoherenceWarning {
  code: string;
  message: string;
}

interface MultiMachineLike {
  // Read only the keys this checker validates, typed FROM the canonical config so a
  // phantom (e.g. the old `.priorities` dict) can't be reintroduced by a hand-edit.
  // (Fix (c) / Decision #4 — mesh-coherence-live-state-honesty.)
  meshTransport?: Pick<
    MeshTransportConfig,
    'enabled' | 'priorityTailscale' | 'priorityLan' | 'priorityCloudflare' | 'bindHost'
  >;
  sessionPool?: { stage?: string; enabled?: boolean };
  leaseTtlMs?: number;
}

/**
 * @param mm the resolved `multiMachine` config block.
 * @param isMultiMachine whether this agent actually runs multi-machine (has a
 *   machine identity / a peer). On a single-machine agent these combinations are
 *   harmless no-ops, so we don't warn.
 */
export function checkMultiMachineConfigCoherence(
  mm: MultiMachineLike | undefined,
  isMultiMachine: boolean,
): ConfigCoherenceWarning[] {
  const warnings: ConfigCoherenceWarning[] = [];
  if (!mm || !isMultiMachine) return warnings;

  // 1) Mesh transport disabled while session transfer is LIVE — the worst-of-both
  //    state: the pool actively moves sessions but the transport reverts to a
  //    single (flaky) rope, reintroducing the lease flap under transfer load.
  const transferLive = mm.sessionPool?.enabled !== false && mm.sessionPool?.stage === 'live-transfer';
  if (mm.meshTransport?.enabled === false && transferLive) {
    warnings.push({
      code: 'mesh-off-while-live-transfer',
      message:
        'multiMachine.meshTransport.enabled=false while sessionPool.stage=live-transfer on a multi-machine agent — ' +
        'session transfer is active but the mesh is single-rope, reintroducing the lease flap. Set meshTransport.enabled=true.',
    });
  }

  // 2) Mesh rope priorities must be DISTINCT positive integers (a tie makes rope selection
  //    nondeterministic). The canonical contract — types.ts:2175 — ships the FLAT keys
  //    priorityTailscale/Lan/Cloudflare (10/20/30); there is NO `.priorities` dict in the
  //    type or in ConfigDefaults, so the dict check this replaces was always dead code
  //    (Fix (c) / Decision #4 — mesh-coherence-live-state-honesty). `mm` is the RESOLVED/
  //    effective config (ConfigDefaults merged), so a user override of one key is validated
  //    against the effective values of the others (Decision #9).
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

  return warnings;
}

/** The self-entry advertised endpoint shape, consumed by `checkMeshLiveStateCoherence`
 *  as a BOOLEAN PRESENCE signal only (see the no-leak invariant). */
export interface MeshLiveState {
  /** The live resolved server bind host (e.g. '0.0.0.0' | '::' | '192.168.1.50' |
   *  '127.0.0.1'). PROCESS-LOCAL and OPERATOR-CONFIG-DERIVED (it comes from this machine's
   *  own resolveMeshBindHost over config.host / meshTransport.bindHost — NOT from peer data),
   *  so it is SAFE to render verbatim in a warning string (no peer-controlled value, no
   *  no-leak concern). b.1 treats it as "mesh is up" when it is ANY non-loopback host —
   *  NOT only the wildcards (see `boundWide`). LIMITATION (R3): this is the RESOLVED-INTENDED
   *  bind (the boot constant from resolveMeshBindHost over config.host / meshTransport.bindHost),
   *  NOT the post-bind actual listening address. The bind cannot change without a restart, so a
   *  boot-constant signal is correct; reading AgentServer's real post-.listen() address is out
   *  of scope. */
  boundHost?: string;
  /** The self-entry advertised endpoints, from idMgr.getMachineEndpoints(selfId).
   *  CONSUMED AS A BOOLEAN PRESENCE SIGNAL ONLY (length > 0) — never as an address,
   *  instruction, or authorization. See the security no-leak invariant below. */
  selfEndpoints?: import('./types.js').MeshEndpoint[];
  /** Milliseconds since this process booted, from `process.uptime() * 1000` — a MONOTONIC
   *  clock (immune to wall-clock jumps / NTP steps; no boot-timestamp capture needed). Gates
   *  the b.2 "inert" warning so it cannot false-fire during the legitimate boot-warmup window.
   *  (Decision #8.) */
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
  // warmup grace is a PARAMETER (the wiring resolves it from the flag's `warmupGraceMs` ??
  // the const and passes it in), so the tuning knob is actually READ. Defaults to the const
  // so unit tests and any caller omitting it keep the 2-min behavior.
  warmupGraceMs: number = MESH_WARMUP_GRACE_MS,
): ConfigCoherenceWarning[] {
  const warnings: ConfigCoherenceWarning[] = [];
  if (!mm || !isMultiMachine) return warnings;

  const configMeshOff = mm.meshTransport?.enabled === false;
  // "wide" must mean NOT-LOOPBACK, not is-wildcard (R2-M10). resolveMeshBindHost can return a
  // SPECIFIC non-loopback host when the operator sets meshTransport.bindHost (e.g.
  // '192.168.1.50') or a non-loopback config.host — the live process is then mesh-UP on that
  // host even though boundHost is neither '0.0.0.0' nor '::'. (Mirrors the isLoopback predicate
  // in resolveMeshBindHost, MeshUrlAdvertiser.ts:229.) `undefined` (no bind observed) is treated
  // as loopback/inert → not wide.
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

export { MESH_WARMUP_GRACE_MS };
