/**
 * TopicProfileStore — sticky per-topic execution profile (framework / model /
 * thinking-mode), TOPIC-PROFILE-SPEC §4/§5.1.
 *
 * Modeled on TopicFrameworksStore for the file/atomic-write shape, with the
 * deliberate departures the spec's review required:
 *
 *  - Single-writer serialized `mutate(topicKey, patch)` (the CommitmentTracker
 *    CAS pattern), NOT a load→overwrite-whole-object `set`. The profile has
 *    three independently-writable axes — a whole-object rewrite would clobber
 *    a concurrently-set field. `mutate` does a read-modify-write under a
 *    per-topic process-local lock, merging only the changed fields.
 *  - In-memory cache is AUTHORITATIVE for reads. The file is read once at
 *    boot and on explicit external-change invalidation only — per-spawn
 *    resolution is O(1) (§5.1).
 *  - Durability precedes acknowledgment: `mutate` resolves only after a flush
 *    containing its write has durably landed (tmp+rename completed). A failed
 *    flush REFUSES the write out loud (throws FlushRefusedError) AND ROLLS
 *    BACK the in-memory mutation to the last durably-flushed snapshot — on a
 *    failed COALESCED flush, every waiter whose write is not yet durable is
 *    refused and rolled back together (§5.1, rounds 5-7).
 *  - Queued flush waiters COALESCE: a mutate arriving while a flush is in
 *    flight is satisfied by a single trailing flush of the latest cache
 *    snapshot — a batch of N writes costs O(1-2) flushes (§5.1, round 6).
 *  - The undo snapshot ({ current, previous }) is durable in the same file;
 *    `previous` shifts once per delta-carrying disclosure — the ORCHESTRATION
 *    layer signals the shift via opts.shiftPrevious (it owns the §8 burst /
 *    coalescing-window accounting); the store never guesses the cadence.
 *  - Legacy `state/topic-frameworks.json` is a ONE-DIRECTIONAL read-only seed
 *    (never overwrites a profile entry) + a profile-store-written mirror so a
 *    binary rollback still reads current framework data (§5.1).
 *  - The dry-run shadow (`intendedProfile`, §14) is a sibling field that
 *    resolution NEVER reads; it has its own lifecycle (flip-clear, skew fates).
 *  - §10.4 parked intended-but-unhealthy profiles + breaker counter live on
 *    the entry so a revert can re-offer the pin and a new operator pin can
 *    atomically supersede the parked state in the same mutate.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { SUPPORTED_FRAMEWORKS } from './TopicFrameworksStore.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import {
  modelTierMutualExclusionError,
  validateProfileFields,
  type EffortLevel,
  type EscalationOverride,
  type ProfileModelTier,
  type ProfileValidationError,
  type ThinkingMode,
} from './topicProfileValidation.js';

/** §4 — the Topic Profile object. Every axis independently nullable. */
export interface TopicProfile {
  framework?: IntelligenceFramework | null;
  /** Explicit BASELINE model id — mutually exclusive with modelTier. */
  model?: string | null;
  /** BASELINE tier pin — mutually exclusive with model. */
  modelTier?: ProfileModelTier | null;
  /** §9 — does the heavy-work ultra mandate still apply? Default 'inherit'. */
  escalationOverride?: EscalationOverride | null;
  thinkingMode?: ThinkingMode | null;
  /**
   * Claude Code `--effort` launch level (low|medium|high|xhigh|max), passed
   * verbatim as `--effort <level>` at spawn — a DIRECT CLI-flag pin, distinct
   * from the cross-framework `thinkingMode` abstraction. No-op on non-claude
   * frameworks.
   */
  effort?: EffortLevel | null;
  /** ISO timestamp, stamped server-side. */
  updatedAt: string;
  /** VERIFIED operator principal (or 'api-token' / 'system:*'), stamped server-side. */
  updatedBy: string;
}

/** §14 — dry-run shadow intent. Resolution NEVER reads this. */
export interface IntendedProfileShadow {
  fields: Omit<TopicProfile, 'updatedAt' | 'updatedBy'>;
  recordedAt: string;
  recordedBy: string;
}

/** §10.4 — a reverted profile retained as intended-but-unhealthy. */
export interface ParkedProfile {
  profile: TopicProfile;
  reason: string;
  parkedAt: string;
}

export interface TopicProfileEntry {
  current: TopicProfile | null;
  /** Undo target — the profile the operator last saw disclosed (§8/R7-4). */
  previous: TopicProfile | null;
  intendedProfile: IntendedProfileShadow | null;
  parked: ParkedProfile | null;
  /** §10.4 consecutive attributable spawn-failure counter. */
  breakerCount: number;
}

interface TopicProfilesFileState {
  updatedAt: string;
  /** Stamp of the last mirror regeneration (§12 rollback-window reconcile). */
  mirrorGeneratedAt?: string;
  topics: Record<string, TopicProfileEntry>;
}

export class FlushRefusedError extends Error {
  constructor(cause: unknown) {
    super(
      `topic-profile flush failed — the write is REFUSED and rolled back (durability precedes acknowledgment): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'FlushRefusedError';
  }
}

export class ProfileLockTimeoutError extends Error {
  constructor(topicKey: string) {
    super(`could not acquire the profile lock for topic ${topicKey} — a respawn is in progress`);
    this.name = 'ProfileLockTimeoutError';
  }
}

export class ProfileValidationRefusal extends Error {
  constructor(public readonly validation: ProfileValidationError) {
    super(validation.reason);
    this.name = 'ProfileValidationRefusal';
  }
}

export interface MutateOptions {
  /**
   * Shift current→previous before applying the patch. The orchestration
   * layer sets this on the FIRST write of a disclosed burst / coalescing
   * window (§5.1 once-per-delta-carrying-disclosure cadence).
   */
  shiftPrevious?: boolean;
  /** WRITE-phase lock-acquisition timeout (ms). Default 5000. */
  lockTimeoutMs?: number;
}

export interface MutateResult {
  /** False when the patch produced no effective field change. */
  changed: boolean;
  entry: TopicProfileEntry;
  /** True when this mutate cleared a §10.4 parked profile (supersession). */
  supersededParked: boolean;
}

export interface ReplaceResult {
  /** False when the arriving entry equals local current (no effective delta). */
  delta: boolean;
  entry: TopicProfileEntry;
  /** §14 skew arm (ii): a populated local shadow retained against a shadowless REPLACE. */
  retainedLocalShadow: boolean;
  /** §14 skew arm (i): an arriving shadow discarded because this machine is not in dry-run. */
  discardedArrivingShadow: boolean;
  /**
   * §5.3/§10.2 receiving-machine revalidation: fields of the ARRIVING entry
   * that failed the closed-enum/framework-compat clamp on this host and fell
   * to the default (null) for that field. Empty when revalidation was not
   * requested or everything validated. The caller owns the one-line
   * disclosure per dropped field (aggregated per §5.3).
   */
  droppedFields: ProfileValidationError[];
}

export interface ReplaceRevalidationOptions {
  /**
   * The framework an arriving model id validates against when the arriving
   * entry does not itself carry a valid framework (§10.2 framework-compat).
   */
  fallbackFramework: IntelligenceFramework;
}

export interface ReplaceOptions {
  /**
   * §5.3 (mandatory at the transfer-apply and §12 restore-apply doors): run
   * the full §10.2 closed-enum + framework-compat clamp over the ARRIVING
   * entry BEFORE persist — never trusted because a peer sent it. A failing
   * field falls to the default (null) for that field and is reported in
   * `droppedFields` for the caller's one-line disclosure. The installed-CLI
   * arm of §5.3 revalidation stays at the resolution boundary
   * (TopicProfileResolver.isLaunchable) so a valid pin is RETAINED — it
   * falls back at launch with the same disclosure, and recovers when the
   * CLI appears. Omitted = no revalidation (trusted local callers only).
   */
  revalidate?: ReplaceRevalidationOptions;
}

export interface TopicProfileStoreOptions {
  /** Absolute path to state/topic-profiles.json. */
  stateFilePath: string;
  /** Absolute path to the legacy state/topic-frameworks.json (seed + mirror). */
  legacyFrameworksPath?: string;
  /** Whether THIS machine is in dry-run (governs arriving-shadow fate, §14). */
  isDryRun?: () => boolean;
  now?: () => Date;
  /** Optional audit sink (rollback-window reconcile + boot events, §12). */
  audit?: (event: Record<string, unknown>) => void;
}

const WRITE_LOCK_TIMEOUT_MS = 5_000;

const PROFILE_FIELDS = ['framework', 'model', 'modelTier', 'escalationOverride', 'thinkingMode', 'effort'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

export class TopicProfileStore {
  private readonly stateFilePath: string;
  private readonly legacyFrameworksPath: string | null;
  private readonly isDryRun: () => boolean;
  private readonly now: () => Date;

  /** AUTHORITATIVE in-memory cache (§5.1). */
  private topics: Record<string, TopicProfileEntry> = {};
  /** Deep snapshot of the last durably-flushed topics map (rollback target). */
  private lastFlushed: Record<string, TopicProfileEntry> = {};
  private mirrorGeneratedAt: string | undefined;

  /** Per-topic process-local locks (promise chains). */
  private locks = new Map<string, Promise<unknown>>();

  /** Store-wide serialized flush queue (§5.1 round-4/6). */
  private flushInFlight: Promise<void> | null = null;
  private trailingFlush: Promise<void> | null = null;

  constructor(options: TopicProfileStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.legacyFrameworksPath = options.legacyFrameworksPath ?? null;
    this.isDryRun = options.isDryRun ?? (() => false);
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit ?? (() => {});
    this.loadFromDisk();
  }

  private readonly audit: (event: Record<string, unknown>) => void;

  // ── reads (cache-only, O(1)) ─────────────────────────────────────────────

  /** Entry for a topic, or null. Cache read — never touches disk. */
  get(topicKey: number | string): TopicProfileEntry | null {
    return this.topics[String(topicKey)] ?? null;
  }

  /** The live profile for a topic (resolution input). Never the shadow. */
  resolve(topicKey: number | string): TopicProfile | null {
    return this.topics[String(topicKey)]?.current ?? null;
  }

  /** Undo target (§10.3). Null when nothing to undo yet. */
  previousFor(topicKey: number | string): TopicProfile | null {
    return this.topics[String(topicKey)]?.previous ?? null;
  }

  /** Admin/migration only (§5.1) — read surfaces use get(). */
  all(): Record<string, TopicProfileEntry> {
    return { ...this.topics };
  }

  // ── per-topic lock (shared ordering primitive, §5.1/§8) ──────────────────

  /**
   * Run `fn` holding the topic's process-local lock. The §8 RESPAWN phase and
   * escalation swaps serialize through this same lock; `mutate` uses it for
   * the WRITE phase. `timeoutMs` bounds ACQUISITION (a wedged holder causes a
   * ProfileLockTimeoutError, not an unbounded queue); the holder itself is
   * bounded by the caller (§8 RESPAWN-phase TTL).
   */
  async withTopicLock<T>(
    topicKey: number | string,
    fn: () => Promise<T> | T,
    timeoutMs = WRITE_LOCK_TIMEOUT_MS,
  ): Promise<T> {
    const key = String(topicKey);
    const prior = this.locks.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    // Chain our slot regardless of the prior holder's outcome.
    const slot = prior.then(() => gate, () => gate);
    this.locks.set(key, slot);

    // Bounded acquisition: wait for the prior holder or time out.
    let acquired = false;
    await Promise.race([
      prior.then(() => (acquired = true), () => (acquired = true)),
      new Promise<void>((res) => setTimeout(res, timeoutMs).unref?.()),
    ]);
    if (!acquired) {
      // Preserve chain integrity: our slot releases only when the still-running
      // prior holder finishes — otherwise the next waiter would run
      // concurrently with it.
      prior.then(() => release(), () => release());
      throw new ProfileLockTimeoutError(key);
    }

    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === slot) this.locks.delete(key);
    }
  }

  // ── mutate (§5.1 WRITE phase) ────────────────────────────────────────────

  /**
   * Field-merged single-writer write. `null` field values CLEAR the field;
   * `undefined` fields are untouched. Enforces the §4 model/modelTier hard
   * mutual exclusion against the MERGE RESULT. Resolves only after the write
   * is durable; throws FlushRefusedError (with rollback) when it is not.
   */
  async mutate(
    topicKey: number | string,
    patch: Partial<Omit<TopicProfile, 'updatedAt'>> & { updatedBy: string },
    opts: MutateOptions = {},
  ): Promise<MutateResult> {
    const key = String(topicKey);
    return this.withTopicLock(
      key,
      async () => {
        const entry = this.entryFor(key);
        const base: TopicProfile = entry.current ?? {
          updatedAt: this.now().toISOString(),
          updatedBy: patch.updatedBy,
        };

        // Merge only the supplied fields.
        const merged: TopicProfile = { ...base };
        let changed = false;
        for (const field of PROFILE_FIELDS) {
          if (patch[field] === undefined) continue;
          const next = patch[field] as TopicProfile[ProfileField];
          if (merged[field] !== next) changed = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (merged as any)[field] = next;
        }

        // §4 hard refusal against the merge RESULT (a patch setting model on
        // a tier-pinned topic without clearing the tier is refused too).
        const exclusion = modelTierMutualExclusionError(merged);
        if (exclusion) throw new ProfileValidationRefusal(exclusion);

        if (!changed) {
          return { changed: false, entry, supersededParked: false };
        }

        merged.updatedAt = this.now().toISOString();
        merged.updatedBy = patch.updatedBy;

        // §10.4 — a deliberate operator pin atomically supersedes a parked
        // intended-but-unhealthy profile + the breaker counter in the SAME
        // mutate. System writes (breaker revert itself) manage parked state
        // through park()/unparkProfile(), not here.
        const isOperatorWrite = !patch.updatedBy.startsWith('system:');
        let supersededParked = false;
        if (isOperatorWrite && entry.parked) {
          entry.parked = null;
          entry.breakerCount = 0;
          supersededParked = true;
        }

        if (opts.shiftPrevious) {
          entry.previous = entry.current ? { ...entry.current } : null;
        }
        entry.current = merged;

        // An accepted LIVE write clears that topic's stale dry-run shadow
        // (§14 supersession discipline).
        if (entry.intendedProfile) entry.intendedProfile = null;

        await this.flushDurably();
        return { changed: true, entry, supersededParked };
      },
      opts.lockTimeoutMs ?? WRITE_LOCK_TIMEOUT_MS,
    );
  }

  // ── REPLACE (transfer-apply / restore-apply, §5.3/§12) ───────────────────

  /**
   * Wholesale per-topic REPLACE — NOT a field-merge (§5.3 round-3: a merge
   * would skip nulls and resurrect a pin the operator cleared remotely).
   * `previous` is pinned to the receiving machine's pre-replace `current`
   * (undo means "back to what this machine had") — EXCEPT when the REPLACE
   * produces no effective delta (A→B→A round-trip, duplicate retried pull):
   * then `previous` must NOT shift (§5.1 round-10).
   *
   * Arriving-shadow fate under regime/timing skew (§14 round-13):
   *  (i) a NON-dry-run receiver discards the arriving shadow;
   *  (ii) an arriving entry with NO shadow never destroys a populated local
   *       shadow on a still-dry-run receiver — it is retained.
   */
  async replaceEntry(
    topicKey: number | string,
    arriving: { current: TopicProfile | null; intendedProfile?: IntendedProfileShadow | null },
    opts: ReplaceOptions = {},
  ): Promise<ReplaceResult> {
    const key = String(topicKey);

    // §5.3/§10.2 — receiving-machine revalidation of the ARRIVING entry
    // (closed-enum + framework-compat) BEFORE it can persist or drive a
    // launch. Failing fields fall to null; provenance travels verbatim.
    let arrivingCurrent = arriving.current;
    let arrivingShadow = arriving.intendedProfile;
    const droppedFields: ProfileValidationError[] = [];
    if (opts.revalidate) {
      const rv = revalidateArrivingProfile(arrivingCurrent, opts.revalidate.fallbackFramework);
      arrivingCurrent = rv.profile;
      droppedFields.push(...rv.dropped);
      if (arrivingShadow != null) {
        const sv = revalidateArrivingShadow(arrivingShadow, opts.revalidate.fallbackFramework);
        arrivingShadow = sv.shadow;
        droppedFields.push(...sv.dropped);
      }
    }

    return this.withTopicLock(key, async () => {
      const entry = this.entryFor(key);
      const delta = !profilesEqual(entry.current, arrivingCurrent);

      let discardedArrivingShadow = false;
      let retainedLocalShadow = false;
      const dryRun = this.isDryRun();
      let nextShadow: IntendedProfileShadow | null;
      if (arrivingShadow != null) {
        if (dryRun) {
          nextShadow = arrivingShadow;
        } else {
          nextShadow = null;
          discardedArrivingShadow = true;
        }
      } else if (entry.intendedProfile != null && dryRun) {
        nextShadow = entry.intendedProfile;
        retainedLocalShadow = true;
      } else {
        nextShadow = null;
      }

      if (delta) {
        entry.previous = entry.current ? { ...entry.current } : null;
        entry.current = arrivingCurrent ? { ...arrivingCurrent } : null;
      }
      entry.intendedProfile = nextShadow;

      await this.flushDurably();
      return { delta, entry, retainedLocalShadow, discardedArrivingShadow, droppedFields };
    });
  }

  // ── dry-run shadow lifecycle (§14) ───────────────────────────────────────

  /** Record a dry-run intent. Never read by resolution. */
  async setShadow(
    topicKey: number | string,
    fields: IntendedProfileShadow['fields'],
    recordedBy: string,
  ): Promise<void> {
    const key = String(topicKey);
    await this.withTopicLock(key, async () => {
      const entry = this.entryFor(key);
      entry.intendedProfile = {
        fields,
        recordedAt: this.now().toISOString(),
        recordedBy,
      };
      await this.flushDurably();
    });
  }

  /**
   * The dryRun true→false flip clears EVERY topic's shadow — intents are
   * NEVER promoted, at the flip or ever (§14 round-12). Returns the cleared
   * intents so the caller can surface the ONE coalesced expired-intents
   * notice.
   */
  async clearAllShadows(): Promise<Array<{ topicKey: string; shadow: IntendedProfileShadow }>> {
    const cleared: Array<{ topicKey: string; shadow: IntendedProfileShadow }> = [];
    for (const [key, entry] of Object.entries(this.topics)) {
      if (entry.intendedProfile) {
        cleared.push({ topicKey: key, shadow: entry.intendedProfile });
        entry.intendedProfile = null;
      }
    }
    if (cleared.length > 0) await this.flushDurably();
    return cleared;
  }

  // ── §10.4 parked-profile + breaker counter ───────────────────────────────

  /** Park the current profile as intended-but-unhealthy and revert. */
  async parkAndRevert(
    topicKey: number | string,
    reason: string,
    revertTo: TopicProfile | null,
  ): Promise<void> {
    const key = String(topicKey);
    await this.withTopicLock(key, async () => {
      const entry = this.entryFor(key);
      if (entry.current) {
        entry.parked = {
          profile: { ...entry.current },
          reason,
          parkedAt: this.now().toISOString(),
        };
      }
      entry.previous = entry.current ? { ...entry.current } : null;
      entry.current = revertTo
        ? { ...revertTo, updatedAt: this.now().toISOString(), updatedBy: 'system:circuit-breaker' }
        : null;
      entry.breakerCount = 0;
      await this.flushDurably();
    });
  }

  /** The parked pin, for the §5.2(b) re-apply recovery write. */
  parkedFor(topicKey: number | string): ParkedProfile | null {
    return this.topics[String(topicKey)]?.parked ?? null;
  }

  /** Clear the parked state (after a successful re-apply). */
  async clearParked(topicKey: number | string): Promise<void> {
    const key = String(topicKey);
    await this.withTopicLock(key, async () => {
      const entry = this.entryFor(key);
      if (entry.parked) {
        entry.parked = null;
        await this.flushDurably();
      }
    });
  }

  /** Increment the attributable spawn-failure counter; returns the new count. */
  async incrementBreaker(topicKey: number | string): Promise<number> {
    const key = String(topicKey);
    return this.withTopicLock(key, async () => {
      const entry = this.entryFor(key);
      entry.breakerCount += 1;
      await this.flushDurably();
      return entry.breakerCount;
    });
  }

  /** §10.4 — the counter resets on any successful spawn. */
  async resetBreaker(topicKey: number | string): Promise<void> {
    const key = String(topicKey);
    await this.withTopicLock(key, async () => {
      const entry = this.entryFor(key);
      if (entry.breakerCount !== 0) {
        entry.breakerCount = 0;
        await this.flushDurably();
      }
    });
  }

  // ── external-change invalidation (§5.1 / §12 restore carrier) ────────────

  /**
   * Explicit cache invalidation — the restore route fires this after a
   * snapshot restore lands on disk (the file is otherwise server-owned
   * single-writer; external edits reconcile only here or at boot).
   */
  invalidateAndReload(): void {
    this.topics = {};
    this.loadFromDisk();
  }

  // ── boot load + legacy seed (§5.1) ───────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<TopicProfilesFileState>;
        if (parsed && typeof parsed === 'object' && parsed.topics && typeof parsed.topics === 'object') {
          for (const [key, value] of Object.entries(parsed.topics)) {
            const entry = sanitizeEntry(value);
            if (entry) this.topics[key] = entry;
          }
          this.mirrorGeneratedAt = typeof parsed.mirrorGeneratedAt === 'string' ? parsed.mirrorGeneratedAt : undefined;
        }
      }
    } catch (err) {
      // Corrupt/unreadable state — boot must succeed; fall back to empty +
      // legacy seed below. Loud in logs, never a throw.
      console.warn(`[TopicProfileStore] Failed to load ${this.stateFilePath}: ${err}`);
      this.topics = {};
    }

    const seeded = this.seedFromLegacy();
    this.lastFlushed = deepCloneTopics(this.topics);
    this.bootFinalize(seeded);
  }

  /**
   * Boot persistence + mirror self-heal (§12). Seeded/reconciled entries are
   * flushed so `topic-profiles.json` exists from first boot, and a mirror
   * that diverges from the profile store is regenerated (the flush path does
   * both). Best-effort and async — boot itself never refuses; the cache is
   * authoritative and the seed is reconstructible at every boot.
   */
  private bootFinalize(seededOrReconciled: boolean): void {
    let needsFlush = seededOrReconciled;
    if (!needsFlush && Object.keys(this.topics).length > 0 && !fs.existsSync(this.stateFilePath)) {
      needsFlush = true;
    }
    if (!needsFlush && this.legacyFrameworksPath) {
      // Mirror divergence check: compare the legacy file's framework view
      // against the profile store's. Divergent → regenerate via flush.
      try {
        const view: Record<string, string> = {};
        for (const [key, entry] of Object.entries(this.topics)) {
          const fw = entry.current?.framework;
          if (fw) view[key] = fw;
        }
        let legacyView: Record<string, string> = {};
        if (fs.existsSync(this.legacyFrameworksPath)) {
          const parsed = JSON.parse(fs.readFileSync(this.legacyFrameworksPath, 'utf-8')) as {
            topics?: Record<string, string>;
          };
          if (parsed?.topics && typeof parsed.topics === 'object') legacyView = parsed.topics;
        }
        if (JSON.stringify(view) !== JSON.stringify(legacyView)) needsFlush = true;
      } catch {
        // Unreadable mirror — the flush below rewrites it.
        needsFlush = true;
      }
    }
    if (needsFlush) {
      void this.flushDurably().catch((err) => {
        console.warn(`[TopicProfileStore] Boot flush failed (cache stays authoritative, retried at next write): ${err}`);
        DegradationReporter.getInstance().report({
          feature: 'TopicProfileStore.bootFlush',
          primary: 'Persist topic-profile state and regenerate the legacy mirror at boot',
          fallback: 'In-memory cache stays authoritative; the durable file and legacy mirror stay stale until the next successful write',
          reason: `Boot flush failed: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'A crash before the next successful write loses boot-time seeds/reconciles; a rolled-back binary would read a divergent legacy mirror',
        });
      });
    }
  }

  /**
   * One-directional read-only seed from the legacy framework store: seed the
   * `framework` field for any topic ABSENT from the profile store. Never
   * overwrites — EXCEPT the §12 rollback-window reconcile: when the legacy
   * file's `updatedAt` differs from the last mirror-write stamp, the legacy
   * file was written by something other than this store's mirror (a rolled-
   * back binary's live `/route` writes), so topics whose framework VALUE
   * differs re-seed the framework arm only, audited. `previous: null` on
   * seeds (§5.1 — undo with no snapshot is refused plainly upstream).
   */
  private seedFromLegacy(): boolean {
    if (!this.legacyFrameworksPath) return false;
    try {
      if (!fs.existsSync(this.legacyFrameworksPath)) return false;
      const raw = fs.readFileSync(this.legacyFrameworksPath, 'utf-8');
      const parsed = JSON.parse(raw) as { updatedAt?: string; topics?: Record<string, string> };
      if (!parsed?.topics || typeof parsed.topics !== 'object') return false;

      // §12 rollback-window predicate: file-level legacy updatedAt vs the
      // mirror-generation stamp. Equal ⇒ the legacy file is our own mirror
      // write — never reconcile values from it (it is read-only output).
      const legacyExternallyWritten =
        typeof parsed.updatedAt === 'string' && parsed.updatedAt !== this.mirrorGeneratedAt;

      // Retain a one-time migration-time snapshot as the rollback artifact.
      const snapshotPath = `${this.legacyFrameworksPath}.pre-profile-seed`;
      let seededAny = false;

      for (const [key, fw] of Object.entries(parsed.topics)) {
        if (typeof fw !== 'string' || !(SUPPORTED_FRAMEWORKS as readonly string[]).includes(fw)) continue;
        const existing = this.topics[key]?.current;
        if (existing) {
          // §12: BOTH predicates — externally written AND file-level legacy
          // updatedAt newer than this entry's profile updatedAt. The second
          // guard keeps the crash-window case (profile flushed, mirror write
          // lost — profile entries are NEWER) from pulling stale legacy
          // values backwards; there the mirror self-heal regenerates instead.
          const legacyNewerThanEntry =
            typeof parsed.updatedAt === 'string' && parsed.updatedAt > existing.updatedAt;
          if (legacyExternallyWritten && legacyNewerThanEntry && existing.framework !== fw) {
            // Rollback-window reconcile: framework arm only, value-differs only.
            existing.framework = fw as IntelligenceFramework;
            existing.updatedAt = this.now().toISOString();
            existing.updatedBy = 'system:rollback-window-reconcile';
            seededAny = true;
            this.audit({
              kind: 'rollback-window-reconcile',
              topicKey: key,
              framework: fw,
              legacyUpdatedAt: parsed.updatedAt,
              mirrorGeneratedAt: this.mirrorGeneratedAt ?? null,
            });
          }
          continue;
        }
        const entry = this.entryFor(key);
        entry.current = {
          framework: fw as IntelligenceFramework,
          updatedAt: this.now().toISOString(),
          updatedBy: 'system:legacy-seed',
        };
        entry.previous = null;
        seededAny = true;
      }

      if (seededAny && !fs.existsSync(snapshotPath)) {
        try {
          fs.copyFileSync(this.legacyFrameworksPath, snapshotPath);
        } catch {
          // @silent-fallback-ok: the §12 rollback snapshot is a best-effort
          // forensic artifact — the seed itself already succeeded (and is
          // audited via the entry writes); a missing snapshot only disables
          // the optional rollback-window reconcile, never live routing.
        }
      }
      return seededAny;
    } catch (err) {
      console.warn(`[TopicProfileStore] Legacy seed from ${this.legacyFrameworksPath} failed: ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'TopicProfileStore.seedFromLegacy',
        primary: 'Seed framework pins from the legacy topic-frameworks file at boot',
        fallback: 'Continue with whatever the profile store already holds — legacy framework routing is not imported',
        reason: `Legacy seed read/parse failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Topics routed by the legacy file may silently resolve to the default framework until re-pinned',
      });
      return false;
    }
  }

  // ── durable flush (serialized + coalescing, §5.1) ────────────────────────

  /**
   * Serialize flushes store-wide. A flush snapshots the authoritative cache
   * AT FLUSH TIME, so a later-completing flush can never persist an older
   * snapshot. Writes arriving mid-flight coalesce onto ONE trailing flush.
   * Failure: every undurable waiter is refused + the cache rolls back to the
   * last durably-flushed snapshot BEFORE the refusals fire.
   */
  private flushDurably(): Promise<void> {
    if (this.flushInFlight) {
      // Coalesce: all waiters during an in-flight flush share one trailing
      // flush of the latest snapshot (their writes are already in the cache).
      if (!this.trailingFlush) {
        this.trailingFlush = this.flushInFlight.then(
          () => {
            this.trailingFlush = null;
            return this.flushDurably();
          },
          (err) => {
            // A failed leader already ROLLED BACK the cache — wiping the
            // trailing waiters' writes too. Refusing them together (rather
            // than flushing the rolled-back state and ACKing silently-dropped
            // writes) is the §5.1 coalesced-failure rule.
            this.trailingFlush = null;
            throw err;
          },
        );
      }
      return this.trailingFlush;
    }

    this.flushInFlight = (async () => {
      const snapshot = deepCloneTopics(this.topics);
      const mirrorStamp = this.mirrorGeneratedAt;
      try {
        await this.writeFileAtomic(snapshot, mirrorStamp);
        this.lastFlushed = snapshot;
      } catch (err) {
        // Rollback to the last durably-flushed snapshot, then refuse loudly.
        this.topics = deepCloneTopics(this.lastFlushed);
        throw new FlushRefusedError(err);
      } finally {
        this.flushInFlight = null;
      }
      this.regenerateMirror(snapshot);
    })();
    return this.flushInFlight;
  }

  private async writeFileAtomic(
    topics: Record<string, TopicProfileEntry>,
    mirrorStamp: string | undefined,
  ): Promise<void> {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const state: TopicProfilesFileState = {
      updatedAt: this.now().toISOString(),
      ...(mirrorStamp ? { mirrorGeneratedAt: mirrorStamp } : {}),
      topics,
    };
    const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.promises.rename(tmp, this.stateFilePath);
  }

  /**
   * §5.1/§12 — the legacy file becomes a read-only mirror regenerated from
   * the profile store (sole writer = this store), so a binary rollback to
   * the prior release still reads current framework data. Best-effort,
   * SECOND (profile file is the source of truth and flushes first), and only
   * rewritten when the framework view actually changed.
   */
  private lastMirrorView: string | null = null;

  private regenerateMirror(topics: Record<string, TopicProfileEntry>): void {
    if (!this.legacyFrameworksPath) return;
    try {
      const view: Record<string, string> = {};
      for (const [key, entry] of Object.entries(topics)) {
        const fw = entry.current?.framework;
        if (fw) view[key] = fw;
      }
      const serialized = JSON.stringify(view);
      if (serialized === this.lastMirrorView) return;
      this.lastMirrorView = serialized;

      const stamp = this.now().toISOString();
      this.mirrorGeneratedAt = stamp;
      const mirror = { updatedAt: stamp, topics: view };
      const tmp = `${this.legacyFrameworksPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(mirror, null, 2), 'utf-8');
      fs.renameSync(tmp, this.legacyFrameworksPath);
    } catch (err) {
      // Mirror divergence self-heals at boot (§12); never fail the write path.
      console.warn(`[TopicProfileStore] Mirror regeneration failed (self-heals at boot): ${err}`);
    }
  }

  /** The mirror-generation stamp (§12 rollback-window reconcile predicate). */
  getMirrorGeneratedAt(): string | undefined {
    return this.mirrorGeneratedAt;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private entryFor(key: string): TopicProfileEntry {
    let entry = this.topics[key];
    if (!entry) {
      entry = { current: null, previous: null, intendedProfile: null, parked: null, breakerCount: 0 };
      this.topics[key] = entry;
    }
    return entry;
  }
}

/**
 * §5.3/§10.2 — clamp an ARRIVING (peer-asserted, untrusted) profile through
 * the closed enums, field by field. Unlike the write-surface refusal
 * (first-error, profile unchanged), transfer-apply degrades PER FIELD: a
 * failing field falls to null (the default for that field at resolution)
 * and is reported for the one-line disclosure; valid sibling fields are
 * kept. Provenance (updatedAt/updatedBy) travels verbatim — a malformed
 * provenance pair means the entry is not a well-formed profile at all and
 * is treated as absent (current: null), reported.
 *
 * The arriving model id validates against the arriving entry's OWN
 * framework when that framework is enum-valid, else `fallbackFramework`
 * (§10.2 framework-compat — a model incompatible with the framework falls).
 * A clamped result holding BOTH model and modelTier drops both (§4 hard
 * mutual exclusion — picking a winner silently is the named anti-pattern).
 */
export function revalidateArrivingProfile(
  arriving: TopicProfile | null,
  fallbackFramework: IntelligenceFramework,
): { profile: TopicProfile | null; dropped: ProfileValidationError[] } {
  if (arriving === null) return { profile: null, dropped: [] };
  const dropped: ProfileValidationError[] = [];

  if (typeof arriving.updatedAt !== 'string' || typeof arriving.updatedBy !== 'string') {
    return {
      profile: null,
      dropped: [
        {
          field: 'updatedAt/updatedBy',
          failure: 'unknown-field',
          reason: 'arriving entry carries malformed provenance — treated as absent',
        },
      ],
    };
  }

  const { fields, fieldDropped } = clampArrivingFields(arriving, fallbackFramework);
  dropped.push(...fieldDropped);

  return {
    profile: {
      ...fields,
      updatedAt: arriving.updatedAt,
      updatedBy: arriving.updatedBy,
    },
    dropped,
  };
}

/** §5.3 — the dry-run shadow travels on the pull and is revalidated the same way. */
export function revalidateArrivingShadow(
  arriving: IntendedProfileShadow,
  fallbackFramework: IntelligenceFramework,
): { shadow: IntendedProfileShadow | null; dropped: ProfileValidationError[] } {
  if (
    !arriving ||
    typeof arriving !== 'object' ||
    typeof arriving.recordedAt !== 'string' ||
    typeof arriving.recordedBy !== 'string' ||
    !arriving.fields ||
    typeof arriving.fields !== 'object'
  ) {
    return {
      shadow: null,
      dropped: [
        {
          field: 'intendedProfile',
          failure: 'unknown-field',
          reason: 'arriving dry-run shadow is malformed — discarded',
        },
      ],
    };
  }
  const { fields, fieldDropped } = clampArrivingFields(arriving.fields, fallbackFramework);
  return {
    shadow: { fields, recordedAt: arriving.recordedAt, recordedBy: arriving.recordedBy },
    dropped: fieldDropped,
  };
}

/** Per-field §10.2 clamp shared by the live-profile and shadow revalidation. */
function clampArrivingFields(
  source: Partial<Record<ProfileField, unknown>>,
  fallbackFramework: IntelligenceFramework,
): { fields: Omit<TopicProfile, 'updatedAt' | 'updatedBy'>; fieldDropped: ProfileValidationError[] } {
  const fieldDropped: ProfileValidationError[] = [];
  const fields: Omit<TopicProfile, 'updatedAt' | 'updatedBy'> = {};

  // Framework first — the model arm validates against it (§10.2).
  let effectiveFramework: IntelligenceFramework = fallbackFramework;
  if (source.framework != null) {
    const v = validateProfileFields({ framework: String(source.framework) }, fallbackFramework);
    if (v.ok && v.patch.framework) {
      fields.framework = v.patch.framework;
      effectiveFramework = v.patch.framework;
    } else if (!v.ok) {
      fieldDropped.push(v.error);
    }
  }

  for (const field of ['model', 'modelTier', 'thinkingMode', 'effort', 'escalationOverride'] as const) {
    const raw = source[field];
    if (raw == null) continue;
    const v = validateProfileFields({ [field]: String(raw) }, effectiveFramework);
    if (v.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fields as any)[field] = (v.patch as any)[field];
    } else {
      fieldDropped.push(v.error);
    }
  }

  // §4 hard mutual exclusion against the clamped result — both set means a
  // divergent/forged peer entry; dropping BOTH is the only non-silent fate.
  const exclusion = modelTierMutualExclusionError(fields);
  if (exclusion) {
    fields.model = null;
    fields.modelTier = null;
    fieldDropped.push(exclusion);
  }

  return { fields, fieldDropped };
}

/** Field-level profile equality over the five profile axes (delta detection). */
export function profilesEqual(a: TopicProfile | null, b: TopicProfile | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  for (const field of PROFILE_FIELDS) {
    if ((a[field] ?? null) !== (b[field] ?? null)) return false;
  }
  return true;
}

function deepCloneTopics(topics: Record<string, TopicProfileEntry>): Record<string, TopicProfileEntry> {
  return JSON.parse(JSON.stringify(topics)) as Record<string, TopicProfileEntry>;
}

function sanitizeEntry(value: unknown): TopicProfileEntry | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<TopicProfileEntry>;
  return {
    current: sanitizeProfile(v.current),
    previous: sanitizeProfile(v.previous),
    intendedProfile:
      v.intendedProfile && typeof v.intendedProfile === 'object'
        ? (v.intendedProfile as IntendedProfileShadow)
        : null,
    parked: v.parked && typeof v.parked === 'object' ? (v.parked as ParkedProfile) : null,
    breakerCount: typeof v.breakerCount === 'number' && v.breakerCount >= 0 ? v.breakerCount : 0,
  };
}

function sanitizeProfile(value: unknown): TopicProfile | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<TopicProfile>;
  if (typeof v.updatedAt !== 'string' || typeof v.updatedBy !== 'string') return null;
  return v as TopicProfile;
}
