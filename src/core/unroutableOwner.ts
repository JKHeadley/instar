/**
 * unroutableOwner — "can this topic's recorded owner EVER be routed to?"
 * (docs/specs/unroutable-owner-release.md).
 *
 * A session-ownership record names a machine. Normally that machine is a pool
 * member: alive (forward to it) or offline (the stale-owner evidence bar decides
 * whether it is provably dead). Two owners are different in kind, because no
 * amount of waiting or probing can ever make them answer:
 *
 *  - REVOKED: the machine registry marks the id revoked. Its key no longer
 *    authenticates, it can never hold the lease, and every mesh message from it
 *    is refused. A rebuilt machine's OLD id is the live example (2026-11-20:
 *    the Studio came back as a new id and ~70 topics stayed owned by the old one,
 *    so owner messages routed to a dead machine forever).
 *  - UNREGISTERED + SILENT: the id is not in this machine's registry at all
 *    (a freshly-rebuilt registry never learned it) AND its replicated journal has
 *    been silent past a bound. Silence is required because a registry can lag a
 *    brand-new pairing; an id we have NEVER seen any journal from is left
 *    ambiguous (escalated, not claimed), since we hold no evidence either way.
 *
 * Pure and deterministic: every input is injected, so both callers (the
 * stale-owner engine's proactive pass and the session router's inbound path)
 * share one definition.
 */

/** 'unavailable' = the registry could not be read: never evidence of anything (reads as routable). */
export type OwnerStanding = 'registered' | 'revoked' | 'unregistered' | 'unavailable';

export type OwnerRoutability =
  | { unroutable: true; reason: 'revoked' | 'unregistered-silent' }
  | {
      unroutable: false;
      reason: 'registered' | 'registry-unavailable' | 'self' | 'unregistered-in-pool-view' | 'unregistered-boot-window' | 'unregistered-no-evidence' | 'unregistered-recent-activity';
    };

export interface OwnerRoutabilityInput {
  owner: string;
  selfMachineId: string | null;
  /** Standing in THIS machine's machine registry. */
  standing: OwnerStanding;
  /** Whether the owner appears in the live pool view (capacities) at all. */
  inPoolView: boolean;
  /** Newest replicated side effect from the owner (placement / session-lifecycle), epoch-ms, or null. */
  lastSideEffectMs: number | null;
  nowMs: number;
  /**
   * How long THIS process has continuously observed the owner as absent from a
   * sane registry (ms). Starts at the first such observation (so it also covers
   * the boot window) and resets whenever the owner is seen registered or the
   * registry is unavailable — a just-vanished entry never qualifies at once.
   */
  absentForMs: number;
  /** Required continuous absence (ms) before an unregistered verdict. */
  absenceWindowMs?: number;
  /** Silence bound for an unregistered owner (ms). */
  silenceBoundMs: number;
}

/**
 * Silence bound for an UNREGISTERED owner: 6 hours. Basis: a live paired machine
 * writes session-lifecycle entries continuously, and once an id leaves the
 * registry this machine stops pulling its stream, so the bound must outlast a
 * registry glitch (git-sync drop, hand edit) that an operator would notice and
 * repair — 6 h of a topic being unroutable from the lease holder is already an
 * outage, so taking it over then restores service rather than risking it.
 */
export const DEFAULT_UNREGISTERED_SILENCE_MS = 6 * 3_600_000;
/** An unregistered verdict never comes from the first minutes after boot. */
export const DEFAULT_UNREGISTERED_BOOT_WINDOW_MS = 3 * 180_000;

export function assessOwnerRoutability(i: OwnerRoutabilityInput): OwnerRoutability {
  // Without a known self identity nothing is decided (self-exclusion and the
  // registry sanity check both need it).
  if (!i.selfMachineId) return { unroutable: false, reason: 'registry-unavailable' };
  if (i.owner === i.selfMachineId) return { unroutable: false, reason: 'self' };
  if (i.standing === 'revoked') return { unroutable: true, reason: 'revoked' };
  if (i.standing === 'registered') return { unroutable: false, reason: 'registered' };
  if (i.standing === 'unavailable') return { unroutable: false, reason: 'registry-unavailable' };
  // Unregistered from here on.
  if (i.inPoolView) return { unroutable: false, reason: 'unregistered-in-pool-view' };
  if (i.absentForMs < (i.absenceWindowMs ?? DEFAULT_UNREGISTERED_BOOT_WINDOW_MS)) return { unroutable: false, reason: 'unregistered-boot-window' };
  // Mirror freshness is NOT consulted here: once an id leaves the registry this
  // machine stops pulling its stream, so a fresh sync says nothing about it. The
  // long silence bound carries the evidence instead.
  if (i.lastSideEffectMs === null) return { unroutable: false, reason: 'unregistered-no-evidence' };
  if (i.nowMs - i.lastSideEffectMs < i.silenceBoundMs) return { unroutable: false, reason: 'unregistered-recent-activity' };
  return { unroutable: true, reason: 'unregistered-silent' };
}

/** Registry standing from a machine-registry snapshot (`machines/registry.json`). */
export function standingFromRegistry(
  machines: Record<string, { status?: string; revokedAt?: string | null }> | undefined,
  machineId: string,
): OwnerStanding {
  // An unreadable/absent snapshot is NOT "the id is missing" — it proves nothing.
  // Nor is an EMPTY registry (a missing registry.json loads as {machines:{}}).
  if (!machines || typeof machines !== 'object' || Object.keys(machines).length === 0) return 'unavailable';
  const e = machines[machineId];
  if (!e) return 'unregistered';
  if (e.status === 'revoked' || e.revokedAt) return 'revoked';
  return 'registered';
}

export interface UnroutableOwnerAssessorDeps {
  selfMachineId: () => string | null;
  /** The machine registry's `machines` map (re-read per call; the registry is small). */
  registryMachines: () => Record<string, { status?: string; revokedAt?: string | null }> | undefined;
  inPoolView: (machineId: string) => boolean;
  lastSideEffectMs: (machineId: string) => number | null;
  /** Informational only (not part of the verdict — an unregistered id's stream is no longer pulled). */
  mirrorLastSyncOkMs?: () => number | null;
  /** Wall-clock ms this process booted (informational; the absence tracker starts at first observation). */
  bootAtMs?: number;
  now?: () => number;
  /** Monotonic clock for the absence window (default performance.now). */
  monoNow?: () => number;
  silenceBoundMs?: number;
}

/**
 * Continuous-absence tracker: when did this process first see `owner` absent from
 * a sane registry? Reset by a registered or unavailable reading.
 */
export class AbsenceTracker {
  private readonly seen = new Map<string, { since: number; last: number }>();
  /**
   * @param maxGapMs a gap between two observations longer than this (missed
   *   sampling, process suspended, clock jump) RESTARTS the window — absence is
   *   only "continuous" if it was actually watched. Call with a MONOTONIC clock.
   */
  constructor(private readonly maxGapMs: number = DEFAULT_ABSENCE_MAX_GAP_MS) {}
  observe(owner: string, standing: OwnerStanding, monoNowMs: number): number {
    if (standing !== 'unregistered') { this.seen.delete(owner); return 0; }
    const s = this.seen.get(owner);
    if (!s || monoNowMs < s.last || monoNowMs - s.last > this.maxGapMs) {
      this.seen.set(owner, { since: monoNowMs, last: monoNowMs });
      return 0;
    }
    s.last = monoNowMs;
    return monoNowMs - s.since;
  }
}

/** Max gap between absence observations (router samples every 60 s; engine ticks every 30 s). */
export const DEFAULT_ABSENCE_MAX_GAP_MS = 180_000;

/** Bind the pure assessment to live seams. Any seam fault reads as ROUTABLE. */
export function createUnroutableOwnerAssessor(d: UnroutableOwnerAssessorDeps): (owner: string) => OwnerRoutability {
  const absence = new AbsenceTracker();
  return (owner) => {
    try {
      const nowMs = (d.now ?? Date.now)();
      const self = d.selfMachineId();
      let machines: ReturnType<UnroutableOwnerAssessorDeps['registryMachines']>;
      try { machines = d.registryMachines(); }
      catch {
        // An unreadable registry is an `unavailable` observation: it RESETS the
        // continuous-absence clock (errors can never bridge an absence window).
        absence.observe(owner, 'unavailable', 0);
        return { unroutable: false, reason: 'registry-unavailable' };
      }
      // A registry that does not even list THIS machine (or an unknown self) is not a sane snapshot.
      const standing: OwnerStanding = !self || (machines && !machines[self]) ? 'unavailable' : standingFromRegistry(machines, owner);
      const absentForMs = absence.observe(owner, standing, (d.monoNow ?? (() => performance.now()))());
      // Cheap first: the journal is read only for an unregistered owner.
      const needJournal = standing === 'unregistered';
      return assessOwnerRoutability({
        owner,
        selfMachineId: self,
        standing,
        inPoolView: needJournal ? d.inPoolView(owner) : false,
        lastSideEffectMs: needJournal ? d.lastSideEffectMs(owner) : null,
        nowMs,
        absentForMs,
        silenceBoundMs: d.silenceBoundMs ?? DEFAULT_UNREGISTERED_SILENCE_MS,
      });
    } catch {
      return { unroutable: false, reason: 'registered' }; /* @silent-fallback-ok — a seam fault keeps today's routing; never a takeover on unreadable evidence */
    }
  };
}

/** The slice of CoherenceJournalReader.query this module needs. */
export interface SideEffectReader {
  query(opts: { kind: string; machine?: string; limit?: number }): { streams: Record<string, { lastTs?: string | null } | undefined> };
}

/**
 * Newest replicated side effect (topic-placement / session-lifecycle) from a
 * machine, epoch-ms, or null. Streams are keyed `<machineId>.<kind>` by
 * CoherenceJournalReader — the U4.2 evidence-5 wiring read `streams[machineId]`
 * and therefore ALWAYS saw null (no side effects), which made the mirror check
 * read every owner as quiet. This is the one correct lookup both callers share.
 */
export function newestSideEffectMs(reader: SideEffectReader, machineId: string): number | null {
  let newest: number | null = null;
  for (const kind of ['topic-placement', 'session-lifecycle'] as const) {
    const res = reader.query({ kind, machine: machineId, limit: 1 });
    const st = res.streams[`${machineId}.${kind}`] ?? res.streams[machineId];
    if (!st?.lastTs) continue; // legitimately empty / absent stream
    const t = Date.parse(st.lastTs);
    // A present-but-malformed timestamp means the newest activity is UNKNOWN —
    // never let an older timestamp from the other stream stand in for it.
    if (!Number.isFinite(t)) return null;
    newest = newest === null ? t : Math.max(newest, t);
  }
  return newest;
}
