/**
 * WorkAdmission — Part C of docs/specs/trustworthy-machine-load-and-mesh-floor.md.
 *
 * Each machine protects its own resources. Fed by this machine's own load verdict
 * (the 15 s MachineLoadSampler, Part B), it decides whether the machine is open
 * to NEW work:
 *
 *   C1  Admission closes at `saturated` or `impaired`, and reopens after
 *       `reopenAfterGoodSamples` (5) consecutive `ok`/`elevated` samples. An
 *       `unknown` sample breaks the reopening streak but never closes admission
 *       (missing evidence is not overload). The state is advertised in the load
 *       report (`acceptingWork`, `admissionEnforced`), so placement elsewhere
 *       skips a machine that refuses work.
 *   C2  One host-wide recovery slot, shared by every agent on the machine (a
 *       HostSpawnSemaphore of capacity 1 in ~/.instar, the same mechanism as the
 *       host LLM-spawn cap). While admission is closed, only an operator-initiated
 *       session may start, and only by taking that slot — the "one session that
 *       can assess and act". Automatic work (scheduled jobs, helpers) is refused
 *       and retried by its caller; nothing is dropped.
 *   C4  After `selfHelpAfterSaturatedSamples` (3) consecutive `saturated`/`impaired`
 *       samples, it runs the deterministic self-help hook once per closed episode
 *       (one deduplicated attention item naming the top processes). No model session.
 *
 * Posture: dev-gated and dry-run first. In dry-run the state machine runs and every
 * refusal it WOULD make is logged and counted, but nothing is refused and the
 * advertised `admissionEnforced` is false, so peers keep placing work here.
 *
 * Signal vs authority: the verdict is computed from multiple independent signals
 * with a 2-of-3 quorum (Part B), the refusal only defers work (jobs retry, inbound
 * messages stay in the durable queue, existing sessions keep receiving messages),
 * and an operator session always has the recovery slot.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HostSpawnSemaphore } from './hostSpawnSemaphore.js';
import type { LoadVerdict } from './machineLoadReport.js';

export type AdmissionKind = 'automatic' | 'operator';

export interface WorkAdmissionConfig {
  enabled: boolean;
  dryRun: boolean;
  reopenAfterGoodSamples: number;
  selfHelpAfterSaturatedSamples: number;
}

export const DEFAULT_WORK_ADMISSION: Omit<WorkAdmissionConfig, 'enabled'> = {
  dryRun: true,
  reopenAfterGoodSamples: 5,
  selfHelpAfterSaturatedSamples: 3,
};

export interface AdmissionDecision {
  allowed: boolean;
  /** Set when the work was (or, in dry-run, would have been) refused. */
  reason?: 'overloaded' | 'recovery-slot-in-use';
  /** True when the decision is a dry-run would-refuse (allowed stays true). */
  wouldRefuse?: boolean;
  /** True when the operator session took the recovery slot. */
  recoverySlot?: boolean;
  detail?: string;
}

export interface WorkAdmissionDeps {
  config: () => WorkAdmissionConfig;
  /** Host-wide recovery slot (capacity 1). Defaults to ~/.instar/host-recovery-slot.json. */
  recoverySlot?: HostSpawnSemaphore;
  /** Live session names on THIS agent, to release a slot whose session already ended. */
  runningSessionNames?: () => string[];
  /** Agent name, used to namespace recovery-slot holder ids across agents on the host. */
  agentName?: string;
  /** Deterministic self-help (C4); called at most once per closed episode. `episodeId` = the ms the episode closed. */
  onSustainedOverload?: (verdict: LoadVerdict, episodeId: number) => void;
  /** Append-only audit (one JSON line per transition / refusal). */
  auditPath?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/** A granted slot is never reclaimed as "ended" inside this window after the grant. */
export const SLOT_STARTUP_GRACE_MS = 5 * 60_000;

/** Audit rotation bound (one kept segment). */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

const CLOSING: ReadonlySet<LoadVerdict> = new Set(['saturated', 'impaired']);
const GOOD: ReadonlySet<LoadVerdict> = new Set(['ok', 'elevated']);

export function defaultRecoverySlotPath(): string {
  return path.join(os.homedir(), '.instar', 'host-recovery-slot.json');
}

export class WorkAdmission {
  private open = true;
  private goodStreak = 0;
  private overloadStreak = 0;
  private selfHelpFiredThisEpisode = false;
  private lastVerdict: LoadVerdict = 'unknown';
  private closedAtMs: number | null = null;
  private lastTransitionAtMs: number | null = null;
  private readonly counters = { closes: 0, reopens: 0, refused: 0, wouldRefuse: 0, schedulerChecksRefused: 0, recoverySlotGrants: 0, recoverySlotRefused: 0, slotLockFailures: 0, selfHelpRuns: 0 };
  /** Recovery-slot grants made by THIS process: session name → grant time (startup grace, see releaseEndedSlots). */
  private readonly granted = new Map<string, number>();
  private readonly slot: HostSpawnSemaphore;
  private readonly now: () => number;
  private readonly agent: string;

  constructor(private readonly d: WorkAdmissionDeps) {
    this.slot = d.recoverySlot ?? new HostSpawnSemaphore({ holdersPath: defaultRecoverySlotPath(), cap: 1 });
    this.now = d.now ?? Date.now;
    this.agent = (d.agentName ?? 'agent').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  }

  /** Feed one sample verdict (called by the load sampler every 15 s). */
  observe(verdict: LoadVerdict): void {
    const cfg = this.d.config();
    this.lastVerdict = verdict;
    if (!cfg.enabled) {
      // Disabled: forget any closed episode so a later re-enable starts open and
      // fresh (never resumes a stale `closed` from before the switch).
      if (!this.open) { this.open = true; this.closedAtMs = null; this.selfHelpFiredThisEpisode = false; }
      this.goodStreak = 0;
      this.overloadStreak = 0;
      return;
    }
    if (CLOSING.has(verdict)) {
      this.goodStreak = 0;
      this.overloadStreak += 1;
      if (this.open) this.transition(false, verdict);
      if (this.overloadStreak >= cfg.selfHelpAfterSaturatedSamples && !this.selfHelpFiredThisEpisode && this.d.onSustainedOverload) {
        this.selfHelpFiredThisEpisode = true;
        this.counters.selfHelpRuns += 1;
        try { this.d.onSustainedOverload(verdict, this.closedAtMs ?? this.now()); } catch (err) {
          this.d.log?.(`self-help failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    this.overloadStreak = 0;
    if (GOOD.has(verdict)) {
      this.goodStreak += 1;
      if (!this.open && this.goodStreak >= cfg.reopenAfterGoodSamples) this.transition(true, verdict);
    } else {
      // unknown: missing evidence never closes admission, but it breaks the streak.
      this.goodStreak = 0;
    }
  }

  private transition(toOpen: boolean, verdict: LoadVerdict): void {
    const cfg = this.d.config();
    this.open = toOpen;
    this.lastTransitionAtMs = this.now();
    if (toOpen) {
      this.counters.reopens += 1;
      this.closedAtMs = null;
      this.selfHelpFiredThisEpisode = false;
    } else {
      this.counters.closes += 1;
      this.closedAtMs = this.now();
    }
    const state = toOpen ? 'open' : 'closed';
    this.d.log?.(`admission ${state} (verdict ${verdict}${cfg.dryRun ? ', dry-run: nothing is refused' : ''})`);
    this.audit({ event: toOpen ? 'reopened' : 'closed', verdict, dryRun: cfg.dryRun });
  }

  /** True when this machine ACTS on its admission state. */
  enforced(): boolean {
    const cfg = this.d.config();
    return cfg.enabled && !cfg.dryRun;
  }

  /** The machine's own view: is it open to new work? (Advertised even in dry-run.) */
  acceptingWork(): boolean {
    return this.d.config().enabled ? this.open : true;
  }

  /** What the load report advertises to peers (null when the feature is dark). */
  advert(): { acceptingWork: boolean; enforced: boolean } | null {
    if (!this.d.config().enabled) return null;
    return { acceptingWork: this.open, enforced: this.enforced() };
  }

  /**
   * A NON-counting read of the automatic-work answer, for callers that poll
   * (the scheduler evaluates its gate on every tick for every job). It writes no
   * audit row and does not inflate `refused`; it keeps its own counter.
   */
  check(): AdmissionDecision {
    const cfg = this.d.config();
    if (!cfg.enabled || this.open) return { allowed: true };
    if (cfg.dryRun) return { allowed: true, wouldRefuse: true, reason: 'overloaded', detail: 'dry-run: this machine is overloaded (automatic work would wait)' };
    this.counters.schedulerChecksRefused += 1;
    return { allowed: false, reason: 'overloaded', detail: 'this machine is overloaded and is not starting new automatic work; it will retry when load eases' };
  }

  /**
   * Admit one new session. `automatic` = scheduled jobs, helpers, any session no
   * person asked for; `operator` = a session the operator started or asked for.
   * `sessionName` keys the recovery slot so it is released when the session ends.
   */
  admit(kind: AdmissionKind, sessionName?: string): AdmissionDecision {
    const cfg = this.d.config();
    if (!cfg.enabled || this.open) return { allowed: true };
    const dry = cfg.dryRun;
    if (kind === 'automatic') {
      return this.refuse(dry, 'overloaded', kind, sessionName);
    }
    // Operator session while closed: only through the host-wide recovery slot.
    this.releaseEndedSlots();
    const id = this.slotId(sessionName);
    if (dry) {
      // Dry-run must not take the real slot; report what WOULD happen.
      const peek = this.slot.peek();
      if (peek.liveHolders >= peek.cap) return this.refuse(true, 'recovery-slot-in-use', kind, sessionName);
      this.audit({ event: 'would-grant-recovery-slot', kind, session: sessionName ?? null });
      return { allowed: true, recoverySlot: false, detail: 'dry-run: would take the recovery slot' };
    }
    if (this.slot.acquire(id)) {
      this.counters.recoverySlotGrants += 1;
      this.granted.set(sessionName ?? 'operator', this.now());
      this.audit({ event: 'recovery-slot-granted', kind, session: sessionName ?? null });
      this.d.log?.(`recovery slot granted to ${sessionName ?? 'an operator session'} (machine is overloaded)`);
      return { allowed: true, recoverySlot: true };
    }
    // acquire() answers false BOTH at the cap and when the holders lock could not be
    // taken (contention / slow disk — likely under the very overload this guards).
    // Only a real holder refuses; a lock failure fails OPEN (reachability over
    // protection), audited so the enforce decision can see it.
    const after = this.slot.peek();
    if (after.liveHolders < after.cap) {
      this.counters.slotLockFailures += 1;
      this.audit({ event: 'slot-lock-failed', kind, session: sessionName ?? null });
      this.d.log?.(`recovery-slot lock unavailable; admitting ${sessionName ?? 'an operator session'} without a holder`);
      return { allowed: true, recoverySlot: false, detail: 'recovery-slot lock unavailable; admitted without a holder' };
    }
    this.counters.recoverySlotRefused += 1;
    return this.refuse(false, 'recovery-slot-in-use', kind, sessionName);
  }

  private refuse(dry: boolean, reason: 'overloaded' | 'recovery-slot-in-use', kind: AdmissionKind, sessionName?: string): AdmissionDecision {
    const detail = reason === 'overloaded'
      ? 'this machine is overloaded and is not starting new automatic work; it will retry when load eases'
      : 'this machine is overloaded and its one recovery session is already in use';
    if (dry) {
      this.counters.wouldRefuse += 1;
      this.audit({ event: 'would-refuse', reason, kind, session: sessionName ?? null });
      return { allowed: true, wouldRefuse: true, reason, detail: `dry-run: ${detail}` };
    }
    this.counters.refused += 1;
    this.audit({ event: 'refused', reason, kind, session: sessionName ?? null });
    return { allowed: false, reason, detail };
  }

  /** Release the recovery slot held for `sessionName` (call when it ends). */
  releaseSlotFor(sessionName: string): void {
    this.granted.delete(sessionName);
    this.slot.release(this.slotId(sessionName));
  }

  /** Release this agent's slot holders whose sessions are no longer running. */
  releaseEndedSlots(): void {
    if (!this.d.runningSessionNames) return;
    let running: Set<string>;
    try { running = new Set(this.d.runningSessionNames()); } catch { return; /* @silent-fallback-ok — cannot tell which sessions run; keep holders (over-counting is the safe side) */ }
    const prefix = `${this.agent}:${process.pid}:`;
    const nowMs = this.now();
    for (const h of this.slot.listHolders()) {
      if (!h.id.startsWith(prefix)) continue;
      const name = h.id.slice(prefix.length);
      if (running.has(name)) continue;
      // A session this process granted the slot to is saved as `running` only after
      // its (slow, under overload) spawn completes: inside the startup grace an
      // absent name is "still booting", not "ended" — never release it.
      const grantedAt = this.granted.get(name);
      if (grantedAt !== undefined && nowMs - grantedAt < SLOT_STARTUP_GRACE_MS) continue;
      this.granted.delete(name);
      this.slot.release(h.id);
    }
  }

  private slotId(sessionName?: string): string {
    return `${this.agent}:${process.pid}:${sessionName ?? 'operator'}`;
  }

  status(): Record<string, unknown> {
    const cfg = this.d.config();
    const peek = this.slot.peek();
    return {
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      enforced: this.enforced(),
      acceptingWork: this.acceptingWork(),
      lastVerdict: this.lastVerdict,
      goodStreak: this.goodStreak,
      overloadStreak: this.overloadStreak,
      reopenAfterGoodSamples: cfg.reopenAfterGoodSamples,
      closedAt: this.closedAtMs ? new Date(this.closedAtMs).toISOString() : null,
      lastTransitionAt: this.lastTransitionAtMs ? new Date(this.lastTransitionAtMs).toISOString() : null,
      recoverySlot: { cap: peek.cap, inUse: peek.liveHolders },
      counters: { ...this.counters },
    };
  }

  private audit(row: Record<string, unknown>): void {
    if (!this.d.auditPath) return;
    try {
      fs.mkdirSync(path.dirname(this.d.auditPath), { recursive: true });
      // Bounded accumulation: rotate to ONE kept segment past AUDIT_MAX_BYTES
      // (declared in state-coherence-registry.json, category audit-work-admission).
      try {
        if (fs.statSync(this.d.auditPath).size >= AUDIT_MAX_BYTES) fs.renameSync(this.d.auditPath, `${this.d.auditPath}.1`);
      } catch { /* @silent-fallback-ok: no file yet, or an unreadable stat — append proceeds; the bound is best-effort */ }
      fs.appendFileSync(this.d.auditPath, JSON.stringify({ ts: new Date(this.now()).toISOString(), ...row }) + '\n');
    } catch {
      // @silent-fallback-ok: the audit is observability; a write failure never changes a decision.
    }
  }
}

/** Typed error thrown by SessionManager when admission refuses a spawn. */
export class AdmissionRefusedError extends Error {
  readonly code = 'admission-refused';
  constructor(readonly reason: string, detail: string) {
    super(`admission-refused (${reason}): ${detail}`);
  }
}

// ── Process-wide handle for the read-only status route ──
let activeAdmission: WorkAdmission | null = null;
export function setActiveWorkAdmission(a: WorkAdmission | null): void { activeAdmission = a; }
export function getActiveWorkAdmission(): WorkAdmission | null { return activeAdmission; }
