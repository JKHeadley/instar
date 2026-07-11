/**
 * machineCoherenceManifest.ts — the coherence-critical manifest (spec §3.1).
 *
 * A fleet-uniform, code-shipped catalog of the flags/versions whose skew across
 * an agent's OWN machines silently halves a cross-machine guarantee (the F4
 * incident class). The manifest ships ATOMIC with the code — every machine on
 * version V evaluates the SAME set — so a key present on one side only is
 * VERSION skew (already alarmed by the version dimension), never phantom flag
 * skew. Spec: docs/specs/machine-coherence-guard.md §3.1/§3.3.
 *
 * Purity contract: this module is pure + deterministic (no I/O, no clock, no
 * LLM). The evaluator (MachineCoherenceSentinel) and the advert builder both
 * consume it; the manifest-size ratchet + membership-drift guard (§3.1 "N5")
 * are unit tests over the exports here.
 *
 * Faithful elaborations of the spec's §3.1 interface sketch (documented, not
 * silent — see the side-effects artifact):
 *   - `dryRunConfigPath?` — the spec's `resolution: 'dev-gate+dryRun'` (and the
 *     "(+ dryRun)" raw rows) inherently need to know WHERE the dry-run flag
 *     lives; the sketch omitted it. It is folded into the effective value.
 *   - The F4 pair (`ws13PinReplicate` + `ws13Reconcile`) is TWO independent
 *     entries sharing one guarantee line, so each key is compared on its own —
 *     strictly finer-grained than a compound row, never coarser.
 */

import { resolveDevAgentGate } from './devAgentGate.js';
import { SEAMLESSNESS_PROTOCOL_VERSION } from './seamlessnessConfig.js';
import crypto from 'node:crypto';

/** How the effective value is computed. */
export type CoherenceResolution = 'raw' | 'dev-gate' | 'dev-gate+dryRun';

/** Where a manifest entry's REAL consumer reads its input from (spec §3.1 M8). */
export type CoherenceReadSource = 'boot' | 'live';

export interface CoherenceCriticalFlag {
  /** Stable key, e.g. 'seamlessness.ws13PinReplicate'. */
  key: string;
  /** Dotted config path to the entry's input value. */
  configPath: string;
  /** How the effective value is computed. */
  resolution: CoherenceResolution;
  /**
   * Dotted config path to the dry-run flag folded into the effective value.
   * Present for every `dev-gate+dryRun` entry and for the "(+ dryRun)" raw
   * rows. Absent → dry-run is not a dimension for this key.
   */
  dryRunConfigPath?: string;
  /**
   * Where the entry's REAL consumer reads it from (spec §3.1 M8): 'boot' = the
   * boot-time config object (a change needs a restart to take effect) | 'live'
   * = liveConfig (a PATCH /config changes behavior with NO restart, e.g.
   * sessionPool.stage). The resolver MUST read each entry the way its real
   * consumer does, or the advert lies about effective behavior.
   */
  readSource: CoherenceReadSource;
  /** One line: the cross-machine guarantee a mixed pool halves (alarm body). */
  guarantee: string;
}

/**
 * The 7 WS2 replicated stores whose per-store `enabled` (+ dryRun) is
 * coherence-critical (replicated-memory reach: a non-advertising peer silently
 * drops the kind). Shipped as a CODE constant, NOT config-derived, so the
 * manifest is fleet-uniform (a fleet config with no stateSync block still
 * carries all 7 rows — same set on every machine at version V).
 */
export const COHERENCE_STATE_SYNC_STORES = [
  'preferences',
  'relationships',
  'learnings',
  'knowledge',
  'evolutionActions',
  'userRegistry',
  'topicOperator',
] as const;

function stateSyncEntries(): CoherenceCriticalFlag[] {
  return COHERENCE_STATE_SYNC_STORES.map((store) => ({
    key: `stateSync.${store}.enabled`,
    configPath: `multiMachine.stateSync.${store}.enabled`,
    resolution: 'dev-gate+dryRun' as const,
    dryRunConfigPath: `multiMachine.stateSync.${store}.dryRun`,
    readSource: 'boot' as const,
    guarantee: `replicated ${store} reach — a non-advertising machine silently drops this store's replicated kind`,
  }));
}

/**
 * COHERENCE_CRITICAL_FLAGS — the manifest (spec §3.1 table). Fleet-uniform,
 * code-shipped. Order is stable (drives manifestHash determinism after sort).
 */
export const COHERENCE_CRITICAL_FLAGS: CoherenceCriticalFlag[] = [
  {
    key: 'seamlessness.ws13PinReplicate',
    configPath: 'multiMachine.seamlessness.ws13PinReplicate',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'multiMachine.seamlessness.ws13DryRun',
    readSource: 'boot',
    guarantee: 'cross-machine conversation-move actuation (the F4 pair)',
  },
  {
    key: 'seamlessness.ws13Reconcile',
    configPath: 'multiMachine.seamlessness.ws13Reconcile',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'multiMachine.seamlessness.ws13DryRun',
    readSource: 'boot',
    guarantee: 'cross-machine conversation-move actuation (the F4 pair)',
  },
  {
    key: 'seamlessness.ws43JournalLease',
    configPath: 'multiMachine.seamlessness.ws43JournalLease',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'multiMachine.seamlessness.ws43JournalLeaseDryRun',
    readSource: 'boot',
    guarantee: 'job-claim single-ownership (a mixed pool keeps the whole pool on the legacy bus)',
  },
  {
    key: 'seamlessness.ws44PoolLinks',
    configPath: 'multiMachine.seamlessness.ws44PoolLinks',
    resolution: 'dev-gate',
    readSource: 'boot',
    guarantee: 'cross-machine private-view link serving',
  },
  {
    key: 'seamlessness.ws44PoolCache',
    configPath: 'multiMachine.seamlessness.ws44PoolCache',
    resolution: 'dev-gate',
    readSource: 'boot',
    guarantee: 'pool-cache fan-out honesty (a mixed pool re-fans per surface)',
  },
  ...stateSyncEntries(),
  {
    key: 'pollFollowsLease.enabled',
    configPath: 'multiMachine.pollFollowsLease.enabled',
    resolution: 'raw',
    dryRunConfigPath: 'multiMachine.pollFollowsLease.dryRun',
    readSource: 'boot',
    guarantee: 'ingress-follows-lease (the July-1 silent-loss shape)',
  },
  {
    key: 'sessionPool.stage',
    configPath: 'multiMachine.sessionPool.stage',
    resolution: 'raw',
    readSource: 'live',
    guarantee: 'whether the pool routes real traffic at all (+ the exactlyOnceIngress default it drives)',
  },
  // ownership-gated-spawn-and-judgment-within-floors §3.2.0: all three
  // pool-behavior flags are coherence-critical — a pool split on any of them
  // halves the one-owner-per-conversation guarantee (one machine enforcing the
  // seam while another spawns freely re-creates the incident). Pool-consistent
  // activation is the PRIMARY defense; this manifest is the alarm layer.
  {
    key: 'sessionPool.ownershipGatedSpawn',
    configPath: 'multiMachine.sessionPool.ownershipGatedSpawn.enabled',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'multiMachine.sessionPool.ownershipGatedSpawn.dryRun',
    readSource: 'boot',
    guarantee: 'binding ownership verdict at every session-creating callsite (one owner per conversation)',
  },
  {
    key: 'sessionPool.duplicateReconciler',
    configPath: 'multiMachine.sessionPool.duplicateReconciler.enabled',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'multiMachine.sessionPool.duplicateReconciler.dryRun',
    readSource: 'boot',
    guarantee: 'duplicate sessions converge to the owner instead of living forever',
  },
  {
    key: 'sessionPool.commitmentCustodyTransfer',
    configPath: 'multiMachine.sessionPool.commitmentCustodyTransfer.enabled',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'multiMachine.sessionPool.commitmentCustodyTransfer.dryRun',
    readSource: 'boot',
    guarantee: 'commitments ride ownership moves (custody skew degrades escalate-safe, still visible)',
  },
  {
    key: 'exactlyOnceIngress',
    configPath: 'multiMachine.exactlyOnceIngress',
    resolution: 'raw',
    readSource: 'live',
    guarantee: 'per-message dedup ledger on every machine',
  },
  {
    key: 'meshTransport.enabled',
    configPath: 'multiMachine.meshTransport.enabled',
    resolution: 'raw',
    readSource: 'boot',
    guarantee: 'multi-rope mesh reachability',
  },
  {
    key: 'developmentAgent',
    configPath: 'developmentAgent',
    resolution: 'raw',
    readSource: 'boot',
    guarantee: 'the ROOT of the F4 class — every omitted-flag resolution flips with it',
  },
  {
    key: 'monitoring.machineCoherence',
    configPath: 'monitoring.machineCoherence.enabled',
    resolution: 'dev-gate+dryRun',
    dryRunConfigPath: 'monitoring.machineCoherence.dryRun',
    readSource: 'boot',
    guarantee: 'the machine-coherence guard itself (a half-dark pool has halved its own alarm redundancy)',
  },
  // ── SelfActionGovernor (unified-self-action-backpressure §Resource scope,
  //    INT5-4/INT6-1/INT7-1): (a) an INVERTED-resolution governor row (the
  //    meshTransport.enabled inverted-default precedent) and (b) per-class
  //    scalar MODE rows for `resource: pool-shared` classes, read LIVE via
  //    the governor-state accessor on the caller-injected view — a config-only
  //    read would advertise `enforce` on a runtime-demoted machine and defeat
  //    the mode-skew alarm. Cross-machine mode skew on a pool-shared class
  //    (enforce on A, observe on B against ONE shared account) silently halves
  //    the sum-of-leases guarantee — the exact F4 shape. ──
  {
    key: 'selfActionGovernor.emergencyDisable',
    configPath: 'intelligence.selfActionGovernor.emergencyDisable',
    resolution: 'raw',
    readSource: 'live',
    guarantee: 'the self-action flood brake itself (a machine with the governor disarmed admits unboundedly)',
  },
  {
    key: 'selfActionGovernor.class.proactive-swap-monitor.mode',
    configPath: 'intelligence.selfActionGovernor.classes.proactive-swap-monitor.mode',
    resolution: 'raw',
    readSource: 'live',
    guarantee: 'pool-shared swap ceiling coherence — a machine enforcing while a peer observes halves the shared-account bound',
  },
  {
    key: 'selfActionGovernor.class.promise-beacon-notify.mode',
    configPath: 'intelligence.selfActionGovernor.classes.promise-beacon-notify.mode',
    resolution: 'raw',
    readSource: 'live',
    guarantee: 'pool-shared notify ceiling coherence — a machine enforcing while a peer observes halves the shared-account bound',
  },
];

/**
 * Explicit membership-exclusion list (spec §3.1 "N5" membership drift guard):
 * every `multiMachine.*` DEV_GATED_FEATURES entry not in the manifest must be
 * named here with a one-line reason. Adding a new coherence-relevant dev-gated
 * flag without a manifest decision fails the drift-guard build test — the F4
 * class cannot be silently re-created for future flags.
 */
export interface CoherenceManifestExclusion {
  configPath: string;
  reason: string;
}

export const COHERENCE_MANIFEST_EXCLUSIONS: CoherenceManifestExclusion[] = [
  { configPath: 'multiMachine.coherenceJournal.enabled', reason: 'content-free local lifecycle journal; a mixed pool degrades to no-journal on one side, not a data guarantee the guard owns' },
  { configPath: 'multiMachine.meshTransport.recoveryProbeEnabled', reason: 'per-machine transport self-heal probe; its own U4.3 episode alarm owns its skew' },
  { configPath: 'multiMachine.secretSync.enabled', reason: 'receive-only by default + per-machine sealed keys; a non-receiver simply re-enters a secret, no silent data-loss' },
  { configPath: 'multiMachine.seamlessness.ws3OneVoice', reason: 'per-machine speaker-election posture; the single-negotiator lease is the coherence authority, not this flag' },
  { configPath: 'multiMachine.writeAdmission.enabled', reason: 'per-machine write-admission gate (ships typed-refusal); a mixed pool degrades to the legacy standby-read-only boolean, not silent loss' },
  { configPath: 'multiMachine.seamlessness.ws41DurableAck', reason: 'durable remote-ack: a non-participant degrades to today\'s in-memory ack, surfaced by its own route' },
  { configPath: 'multiMachine.accountFollowMe.enabled', reason: 'account/quota metadata projection; operator-mandate-gated per machine, not a silent guarantee' },
  { configPath: 'multiMachine.seamlessness.ws43RoleGuard', reason: 'spawn-boundary role re-check; a non-participant keeps today\'s behavior, raises its own deduped item' },
  { configPath: 'multiMachine.durableOwnership.enabled', reason: 'per-machine durable-ownership record; ownership placement has its own coherence surface' },
  { configPath: 'multiMachine.ownershipFollowsLiveWork', reason: 'placement heuristic; per-machine, no cross-machine data-loss guarantee' },
  { configPath: 'multiMachine.sessionPool.staleOwnerRelease.enabled', reason: 'failover reconciler; its own /pool/stale-owner-release telemetry owns its state' },
  { configPath: 'multiMachine.sessionPool.enabled', reason: 'legacy pool gate; sessionPool.stage (in manifest) is the coherence-relevant routing key' },
  { configPath: 'multiMachine.sessionPool.inboundQueue.enabled', reason: 'per-machine durable inbound queue; its own /pool/queue loss-notices surface skew' },
  { configPath: 'multiMachine.sessionPool.holdForStability.enabled', reason: 'per-machine hold policy; trails inboundQueue by one rung, no cross-machine data guarantee' },
  { configPath: 'multiMachine.sessionPool.ownershipCheckedSpawn.enabled', reason: 'per-machine spawn ownership check; no silent cross-machine guarantee' },
  { configPath: 'multiMachine.leaseSelfHeal.staleHolderTakeover.enabled', reason: 'lease self-heal reconciler; the lease/split-brain machinery owns its coherence' },
  { configPath: 'multiMachine.leaseSelfHeal.silentStandbyRelinquish.enabled', reason: 'lease self-heal reconciler; lease-layer owned' },
  { configPath: 'multiMachine.leaseSelfHeal.soloCaptainHold.enabled', reason: 'lease self-heal reconciler; lease-layer owned' },
  { configPath: 'multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled', reason: 'lease self-heal reconciler; lease-layer owned + operator latch' },
  { configPath: 'multiMachine.stateSync.threadlinePairing.enabled', reason: 'verified-pairing store; a non-participant fails-closed on credential share (its own gate), not a silent memory-reach loss like the 7 WS2 stores' },
  { configPath: 'multiMachine.sessionPool.moveIntent.enabled', reason: 'per-machine inbound move-intent recognizer; fail-open + dry-run-first, a non-participant just passes the message through (never hijacks), no cross-machine data-loss guarantee it owns' },
  { configPath: 'multiMachine.sessionPool.judgmentArbiters.enabled', reason: 'per-machine LLM arbiter layer (shadow-first) INSIDE deterministic floors; a non-participant runs the same floors\' static defaults — no cross-machine guarantee of its own (the three pool-behavior flags that DO halve a guarantee are in the manifest)' },
];

// ─── Clamp + byte bounds (spec §3.1) ─────────────────────────────────────
export const MC_MAX_ENTRIES = 64;
export const MC_KEY_MAX = 64;
export const MC_VALUE_MAX = 32;
/** fixed-fields + flags portion of the advert, serialized. */
export const MC_FLAGS_BYTES_MAX = 2048;
/** the §3.2 alarm marker sub-budget. */
export const MC_MARKER_BYTES_MAX = 1536;
/** whole coherenceAdvert block. */
export const MC_BLOCK_BYTES_MAX = 3584;
/** alarm marker rowIdentityHashes clamp (>= any ratchet-passing manifest's row count). */
export const MC_MARKER_ROWS_MAX = 72;
/** per-row identity hash length (truncated, hex). */
export const MC_ROW_HASH_LEN = 16;

/** Effective-value alphabet for a clamped scalar (spec §3.1/M4/R5-N3). */
export const MC_VALUE_ALPHABET = /^[a-z0-9-]{1,32}$/;
/** instarVersion alphabet (spec §3.2 M4 receive clamp). */
export const MC_VERSION_ALPHABET = /^[0-9A-Za-z.+-]{1,32}$/;
/** manifestHash: 64 lowercase hex. */
export const MC_MANIFEST_HASH_RE = /^[0-9a-f]{64}$/;
/** episodeId format (spec §3.2 N4). */
export const MC_EPISODE_ID_RE = /^mc-\d{1,29}$/;

/** Read a dotted config path off a plain object (undefined on any miss). */
export function getByPath(obj: unknown, dotted: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The config view the resolver reads: a boot config object + optional live getter. */
export interface CoherenceConfigView {
  /** The full boot-time agent config object. */
  boot: Record<string, unknown>;
  /**
   * Optional live-config getter (liveConfig.get(path, fallback)). Used for
   * `readSource: 'live'` entries so a PATCH /config change is reflected with no
   * restart. Absent → live entries fall back to the boot value.
   */
  liveGet?: (path: string, fallback: unknown) => unknown;
  /**
   * Governor-state accessor (unified-self-action-backpressure INT7-1/LA7-2 —
   * the view-seam extension): resolves a self-action class's LIVE runtime mode
   * (`observe` | `enforce` | `demoted`) for the per-class coherence rows. The
   * `demoted` value is governor RUNTIME latch state no config path resolves —
   * a config-only read would advertise `enforce` on a runtime-demoted machine.
   * Absent → the class-mode rows fall back to the config value ('observe'
   * default), honestly weaker but never throwing.
   */
  governorClassMode?: (controllerId: string) => string;
}

function clampValue(v: string): string {
  const s = String(v).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, MC_VALUE_MAX);
  return s.length ? s : 'unknown';
}

/**
 * Resolve one manifest entry's effective value against a config view.
 * Deterministic; identical across two machines on the same manifest generation.
 * Returns a clamped scalar string ('live' | 'dry-run' | 'off' | a stage class).
 */
export function resolveFlagValue(entry: CoherenceCriticalFlag, view: CoherenceConfigView): string {
  const cfg = view.boot;
  // Special-cased scalars (non-boolean effective values).
  switch (entry.key) {
    case 'developmentAgent':
      return cfg?.developmentAgent === true ? 'true' : 'false';
    case 'selfActionGovernor.emergencyDisable': {
      // INVERTED resolution (the meshTransport precedent): the governor ships
      // default-ON; `emergencyDisable === true` is the OFF direction.
      const raw = view.liveGet
        ? view.liveGet(entry.configPath, getByPath(cfg, entry.configPath))
        : getByPath(cfg, entry.configPath);
      return raw === true ? 'off' : 'live';
    }
    case 'selfActionGovernor.class.proactive-swap-monitor.mode':
    case 'selfActionGovernor.class.promise-beacon-notify.mode': {
      // readSource 'live' against the governor-state accessor: only the
      // runtime knows `demoted` (a latch, not a config value).
      const controllerId = entry.key.split('.')[2];
      if (view.governorClassMode) {
        try {
          const mode = view.governorClassMode(controllerId);
          if (mode === 'observe' || mode === 'enforce' || mode === 'demoted') return mode;
        } catch {
          /* fall through to the config read — never throw in the advert */
        }
      }
      const raw = view.liveGet
        ? view.liveGet(entry.configPath, getByPath(cfg, entry.configPath))
        : getByPath(cfg, entry.configPath);
      return raw === 'enforce' ? 'enforce' : 'observe';
    }
    case 'meshTransport.enabled': {
      const raw = getByPath(cfg, 'multiMachine.meshTransport.enabled');
      // meshTransport ships ENABLED by default (Layers 0-2 additive).
      return raw === false ? 'off' : 'live';
    }
    case 'sessionPool.stage': {
      const pool = view.liveGet
        ? (view.liveGet('multiMachine.sessionPool', getByPath(cfg, 'multiMachine.sessionPool')) as Record<string, unknown> | undefined)
        : (getByPath(cfg, 'multiMachine.sessionPool') as Record<string, unknown> | undefined);
      const stage = pool && typeof pool.stage === 'string' ? pool.stage : 'dark';
      return clampValue(stage);
    }
    case 'exactlyOnceIngress': {
      const mm = getByPath(cfg, 'multiMachine') as Record<string, unknown> | undefined;
      const pool = view.liveGet
        ? (view.liveGet('multiMachine.sessionPool', getByPath(cfg, 'multiMachine.sessionPool')) as Record<string, unknown> | undefined)
        : (getByPath(cfg, 'multiMachine.sessionPool') as Record<string, unknown> | undefined);
      const explicit = mm ? mm.exactlyOnceIngress : undefined;
      const stage = pool && typeof pool.stage === 'string' ? pool.stage : undefined;
      const resolved = typeof explicit === 'boolean'
        ? explicit
        : stage === 'live-transfer' || stage === 'rebalance';
      return resolved ? 'live' : 'off';
    }
    default:
      break;
  }

  // Boolean-fold path (raw / dev-gate / dev-gate+dryRun with an optional dryRun fold).
  const rawEnabled = getByPath(cfg, entry.configPath);
  let enabled: boolean;
  if (entry.resolution === 'raw') {
    enabled = rawEnabled === true;
  } else {
    enabled = resolveDevAgentGate(
      typeof rawEnabled === 'boolean' ? rawEnabled : undefined,
      cfg as { developmentAgent?: boolean },
    );
  }
  if (!enabled) return 'off';
  if (entry.dryRunConfigPath) {
    const dry = getByPath(cfg, entry.dryRunConfigPath);
    // Convention: a dev-gated dry-run defaults TRUE (first rung); a raw dry-run
    // (pollFollowsLease) defaults FALSE (live once enabled).
    const dryDefault = entry.resolution !== 'raw';
    const isDry = typeof dry === 'boolean' ? dry : dryDefault;
    return isDry ? 'dry-run' : 'live';
  }
  return 'live';
}

/**
 * Build the manifest-resolved effective-value map (advert `flags`). Keys are the
 * manifest keys, values clamped scalars. Deterministic + pure.
 */
export function buildCoherenceFlags(view: CoherenceConfigView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of COHERENCE_CRITICAL_FLAGS) {
    out[entry.key] = clampValue(resolveFlagValue(entry, view));
  }
  return out;
}

/**
 * Compute the manifest hash — sha256 over the sorted ENTRIES (key + resolution
 * + readSource), NOT just the key list (spec §3.1 M7: two builds can share keys
 * but differ in resolution semantics). Lowercase hex, 64 chars.
 */
export function computeManifestHash(flags: CoherenceCriticalFlag[] = COHERENCE_CRITICAL_FLAGS): string {
  const canonical = flags
    .map((f) => `${f.key}|${f.resolution}|${f.readSource}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** The manifest hash for THIS build's shipped manifest (memoized-safe, pure). */
export function selfManifestHash(): string {
  return computeManifestHash(COHERENCE_CRITICAL_FLAGS);
}

/** Protocol version this build advertises (mirrors the seamlessness layer). */
export function selfProtocolVersion(): number {
  return SEAMLESSNESS_PROTOCOL_VERSION;
}
