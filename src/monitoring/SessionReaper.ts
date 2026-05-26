/**
 * SessionReaper — pressure-aware, positive-evidence reaper for idle-but-alive
 * sessions. SESSION-REAPER-SPEC.md (v2 CONVERGED).
 *
 * THE hard requirement: NEVER reap a working session. The classifier does NOT
 * infer idleness from the ABSENCE of activity (a session mid-LLM-generation or
 * mid-network-call looks identical to an idle one). It requires POSITIVE proof
 * the turn is complete and the session is parked at a ready prompt, PLUS render
 * stasis across ticks, PLUS quiet process+transcript — and every signal carries
 * a confidence. Any ambiguity, any low-confidence/unresolvable signal → KEEP.
 *
 * Reaping is gated again by: hysteresis (continuous candidacy across N ticks),
 * a pressure-adaptive idle threshold (does almost nothing at Normal), a bounded
 * per-tick/per-hour budget, and a two-phase reap (mark reap-pending, then on a
 * later tick re-confirm the full classifier fresh before terminating). Ships
 * dry-run/off by default; auto-disables to dry-run on any ambiguous/failed reap.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../core/types.js';
import { getActivitySignal } from './frameworkActivitySignals.js';
import { probeTranscript, transcriptDelta, type TranscriptProbe } from './transcriptProber.js';

export type PressureTier = 'normal' | 'moderate' | 'critical';
export type Verdict = 'keep' | 'reap-eligible';
export type Confidence = 'high' | 'low';

export interface SessionReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  tickIntervalSec: number;
  minAgeMinutes: number;
  confirmObservations: number;
  confirmWindowMinutes: number;
  paneCaptureLines: number;
  recentUserWindowMinutes: number;
  idleThresholdModerateMinutes: number;
  idleThresholdCriticalMinutes: number;
  normalTierReaps: boolean;
  maxReapsPerTick: number;
  maxReapsPerHour: number;
  finalGraceSec: number;
  protectOpenCommitments: boolean;
}

export const DEFAULT_SESSION_REAPER_CONFIG: SessionReaperConfig = {
  enabled: false,
  dryRun: true,
  tickIntervalSec: 120,
  minAgeMinutes: 30,
  confirmObservations: 3,
  confirmWindowMinutes: 10,
  paneCaptureLines: 200,
  recentUserWindowMinutes: 30,
  idleThresholdModerateMinutes: 45,
  idleThresholdCriticalMinutes: 15,
  normalTierReaps: false,
  maxReapsPerTick: 3,
  maxReapsPerHour: 12,
  finalGraceSec: 60,
  protectOpenCommitments: true,
};

/** A single signal's outcome. `keep:true` short-circuits the classifier. */
interface SignalResult {
  keep: boolean;
  /** Gate/signal name when keep:true (for observability). */
  reason?: string;
  confidence: Confidence;
}

/** Per-tick evaluation of one session (stateless w.r.t. hysteresis). */
export interface SessionEvaluation {
  verdict: Verdict;
  /** The gate that forced KEEP (or 'all-clear' when reap-eligible). */
  keptBy: string;
  confidence: Confidence;
  /** Captured pane frame (for render-stasis comparison across ticks). */
  frame: string;
  /** Transcript probe this tick (for growth comparison across ticks). */
  transcript: TranscriptProbe;
}

export interface PressureReading {
  tier: PressureTier;
  /** Free-form inputs for observability. */
  inputs?: Record<string, unknown>;
}

/**
 * All external signal sources are injected so the classifier is fully unit
 * testable without tmux/fs/sqlite. Production wiring supplies SessionManager-
 * and tracker-backed implementations.
 */
export interface SessionReaperDeps {
  listRunningSessions: () => Session[];
  captureOutput: (tmuxSession: string, lines: number) => string;
  hasActiveProcesses: (tmuxSession: string) => boolean;
  /** Optional main-process liveness (CPU/IO delta). `undefined` return = cannot
   *  inspect → treated as POSSIBLY active (KEEP), per the confidence contract. */
  mainProcessActive?: (tmuxSession: string) => boolean | undefined;
  frameworkForSession: (tmuxSession: string) => 'claude-code' | 'codex-cli' | undefined;
  /** Resolve+stat the session's transcript. Defaults to {@link probeTranscript}. */
  probeTranscript?: (session: Session) => TranscriptProbe;
  isRecoveryActive: (session: Session) => boolean;
  isRelayLeaseActive: (sessionId: string) => boolean;
  hasPendingInjection: (tmuxSession: string) => boolean;
  /** Bound topic id for a session, or null. */
  topicBinding: (tmuxSession: string) => number | null;
  recentUserMessage: (topicId: number, withinMs: number) => boolean;
  activeCommitmentForTopic: (topicId: number) => boolean;
  /** Count of active subagents for a session's claudeSessionId (0 when absent). */
  activeSubagentCount: (claudeSessionId: string | undefined) => number;
  buildOrAutonomousActive: (topicId: number | null) => boolean;
  protectedSessions: () => string[];
  pressure: () => PressureReading;
  terminate: (sessionId: string, reason: string) => Promise<{ terminated: boolean; skipped?: string }>;
  markReaping: (sessionId: string) => void;
  clearReaping: (sessionId: string) => void;
  now?: () => number;
  /** Structured audit sink (sentinel-events.jsonl). */
  audit?: (event: Record<string, unknown>) => void;
}

interface Obs {
  /** When continuous reap-candidacy began (ms). */
  candidateSince: number;
  /** Consecutive candidate observations. */
  consecutive: number;
  /** Last captured pane frame (render-stasis). */
  lastFrame: string;
  /** Transcript probe from the previous tick (growth comparison). */
  lastTranscript: TranscriptProbe;
  /** When this session entered reap-pending (two-phase), if it has. */
  reapPendingSince?: number;
}

export class SessionReaper extends EventEmitter {
  private readonly cfg: SessionReaperConfig;
  private readonly deps: SessionReaperDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private obs = new Map<string, Obs>();
  private reapTimestamps: number[] = []; // for per-hour budget
  /** Flips to true (forcing dry-run) after any ambiguous/failed reap. */
  private autoDisabled = false;
  private lastTickAt = 0;

  constructor(deps: SessionReaperDeps, cfg?: Partial<SessionReaperConfig>) {
    super();
    this.deps = deps;
    this.cfg = { ...DEFAULT_SESSION_REAPER_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.tickIntervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Whether kills are actually performed (vs dry-run logged). */
  private get killsEnabled(): boolean {
    return this.cfg.enabled && !this.cfg.dryRun && !this.autoDisabled;
  }

  private probe(session: Session): TranscriptProbe {
    if (this.deps.probeTranscript) return this.deps.probeTranscript(session);
    const framework = session.framework ?? this.deps.frameworkForSession(session.tmuxSession) ?? 'claude-code';
    // Claude uses claudeSessionId; Codex's transcript is globbed by its session
    // id which we do not separately track → unresolved → KEEP (safe).
    const sessionId = framework === 'claude-code' ? (session.claudeSessionId ?? '') : '';
    return probeTranscript({ framework, sessionId, projectDir: '' });
  }

  /**
   * Positive idle detection: returns true ONLY if the frame affirmatively shows
   * a ready-for-input prompt AND contains no active-work marker. Conservative —
   * an undetected ready prompt returns false (→ KEEP), never a false idle.
   */
  static isPositivelyIdle(framework: 'claude-code' | 'codex-cli' | undefined, frame: string): boolean {
    if (!framework) return false; // unknown framework → cannot positively assert idle
    const sig = getActivitySignal(framework);
    // Any active marker anywhere in the captured buffer ⇒ not idle.
    if (sig.toolCallOrSpinner.test(frame) || sig.escapeToInterrupt.test(frame) || sig.runningIndicator.test(frame)) {
      return false;
    }
    // Positive ready-prompt signatures (conservative; tunable via dry-run).
    if (framework === 'claude-code') {
      return /bypass permissions|\? for shortcuts|auto-accept edits|shift\+tab/i.test(frame)
        || /\n\s*>\s*$/.test(frame.trimEnd() + '\n');
    }
    // codex-cli: a ready prompt with no working status line. The model-name idle
    // line is NOT a reliable positive, so require the explicit input affordance.
    return /\? for shortcuts|send a message|type a message|\bEsc\b.*interrupt/i.test(frame) === false
      ? /\n\s*›\s*$|\n\s*▌|send your message/i.test(frame)
      : false;
  }

  /**
   * Stateless per-tick evaluation. Returns KEEP unless EVERY gate clears with
   * high confidence. Order: cheap protect-gates first (short-circuit), then the
   * positive-idle + activeness checks.
   */
  evaluate(session: Session): SessionEvaluation {
    const framework = session.framework ?? this.deps.frameworkForSession(session.tmuxSession);
    const frame = safeCapture(this.deps, session.tmuxSession, this.cfg.paneCaptureLines);
    const transcript = this.probe(session);

    const keep = (reason: string, confidence: Confidence = 'high'): SessionEvaluation =>
      ({ verdict: 'keep', keptBy: reason, confidence, frame, transcript });

    // A. Protected set
    if (this.deps.protectedSessions().includes(session.tmuxSession)) return keep('protected');
    // M. Spawn grace
    const ageMs = this.now() - Date.parse(session.startedAt);
    if (!(ageMs >= this.cfg.minAgeMinutes * 60_000)) return keep('spawn-grace');
    // G. Recovery in flight
    if (this.deps.isRecoveryActive(session)) return keep('recovery-in-flight');
    // H. Pending injection / relay lease
    if (this.deps.hasPendingInjection(session.tmuxSession)) return keep('pending-injection');
    if (this.deps.isRelayLeaseActive(session.id)) return keep('relay-lease');

    const topicId = this.deps.topicBinding(session.tmuxSession);
    // I. Recent user interaction (topic unresolved while bound → cannot tell → KEEP)
    if (topicId != null && this.deps.recentUserMessage(topicId, this.cfg.recentUserWindowMinutes * 60_000)) {
      return keep('recent-user-message');
    }
    // J. Open commitment on the bound topic
    if (this.cfg.protectOpenCommitments && topicId != null && this.deps.activeCommitmentForTopic(topicId)) {
      return keep('open-commitment');
    }
    // K. Active subagent
    if (this.deps.activeSubagentCount(session.claudeSessionId) > 0) return keep('active-subagent');
    // L. Structural long-work (build/autonomous) on the topic/project
    if (this.deps.buildOrAutonomousActive(topicId)) return keep('structural-long-work');

    // ── Activeness (positive-evidence) ──
    // C. Process tree: any non-baseline child ⇒ working.
    if (this.deps.hasActiveProcesses(session.tmuxSession)) return keep('active-process');
    // C(main): main-process CPU/IO delta. undefined ⇒ cannot inspect ⇒ KEEP.
    if (this.deps.mainProcessActive) {
      const mp = this.deps.mainProcessActive(session.tmuxSession);
      if (mp === undefined) return keep('process-uninspectable', 'low');
      if (mp === true) return keep('main-process-active');
    }
    // E. Transcript growth this tick (vs last tick). 'grew' ⇒ working;
    //    'unknown' (unresolved/rotated) ⇒ KEEP.
    const prev = this.obs.get(session.id)?.lastTranscript;
    if (prev) {
      const delta = transcriptDelta(prev, transcript);
      if (delta === 'grew') return keep('transcript-grew');
      if (delta === 'unknown') return keep('transcript-unresolved', 'low');
    } else if (!transcript.resolved) {
      // First sighting with an unresolvable transcript: cannot prove idle. KEEP.
      return keep('transcript-unresolved', 'low');
    }
    // (1) Positive idle proof — REQUIRED. No positive ready-prompt ⇒ KEEP.
    if (!SessionReaper.isPositivelyIdle(framework, frame)) return keep('no-positive-idle');

    // All gates clear: this tick the session is a reap candidate.
    return { verdict: 'reap-eligible', keptBy: 'all-clear', confidence: 'high', frame, transcript };
  }

  /** Active idle threshold (ms) for the current pressure tier. */
  private thresholdMs(tier: PressureTier): number | null {
    if (tier === 'normal') return this.cfg.normalTierReaps ? this.cfg.idleThresholdModerateMinutes * 60_000 : null;
    if (tier === 'moderate') return this.cfg.idleThresholdModerateMinutes * 60_000;
    return this.cfg.idleThresholdCriticalMinutes * 60_000;
  }

  private hourlyBudgetRemaining(): number {
    const cutoff = this.now() - 3_600_000;
    this.reapTimestamps = this.reapTimestamps.filter(t => t >= cutoff);
    return this.cfg.maxReapsPerHour - this.reapTimestamps.length;
  }

  async tick(): Promise<void> {
    if (!this.cfg.enabled || this.running) return;
    this.running = true;
    this.lastTickAt = this.now();
    try {
      const pressure = this.deps.pressure();
      const threshold = this.thresholdMs(pressure.tier);
      const sessions = this.deps.listRunningSessions();
      const live = new Set(sessions.map(s => s.id));
      // GC obs for vanished sessions.
      for (const id of [...this.obs.keys()]) if (!live.has(id)) { this.obs.delete(id); this.deps.clearReaping(id); }

      let reapedThisTick = 0;
      for (const session of sessions) {
        let evaln: SessionEvaluation;
        try {
          evaln = this.evaluate(session);
        } catch {
          // A protect-signal threw — we cannot reason about this session, so
          // KEEP it (abort any reap-pending) and reset candidacy. Never reap on
          // a failed evaluation.
          this.deps.clearReaping(session.id);
          this.obs.set(session.id, { candidateSince: 0, consecutive: 0, lastFrame: '', lastTranscript: { resolved: false, path: '', size: 0, mtime: 0 } });
          continue;
        }
        const prior = this.obs.get(session.id);
        const now = this.now();

        if (evaln.verdict === 'keep') {
          // Any non-candidate observation resets candidacy + aborts reap-pending.
          if (prior?.reapPendingSince != null) {
            this.deps.clearReaping(session.id);
            this.audit('reap-aborted', session, { keptBy: evaln.keptBy });
          }
          this.obs.set(session.id, { candidateSince: 0, consecutive: 0, lastFrame: evaln.frame, lastTranscript: evaln.transcript });
          continue;
        }

        // Candidate this tick. Render-stasis: the frame must be byte-identical
        // to last tick. A changed frame ⇒ activity ⇒ reset candidacy.
        const frameStatic = prior != null && prior.consecutive > 0 && prior.lastFrame === evaln.frame;

        // If we were reap-pending and the frame is no longer static, the session
        // rendered something during the grace window — abort the reap (§3.5).
        if (prior?.reapPendingSince != null && !frameStatic) {
          this.deps.clearReaping(session.id);
          this.audit('reap-aborted', session, { reason: 'frame-changed-during-grace' });
          this.obs.set(session.id, { candidateSince: now, consecutive: 1, lastFrame: evaln.frame, lastTranscript: evaln.transcript });
          continue;
        }

        const consecutive = frameStatic ? prior!.consecutive + 1 : 1;
        const candidateSince = frameStatic && prior!.candidateSince ? prior!.candidateSince : now;
        const next: Obs = { candidateSince, consecutive, lastFrame: evaln.frame, lastTranscript: evaln.transcript, reapPendingSince: prior?.reapPendingSince };

        // Two-phase: if already reap-pending, see if the grace window elapsed.
        if (next.reapPendingSince != null) {
          if (now - next.reapPendingSince >= this.cfg.finalGraceSec * 1000) {
            // Final confirmation already passed THIS tick's full classifier
            // (we're here ⇒ still reap-eligible + render-static). Terminate.
            const canReap = threshold != null && reapedThisTick < this.cfg.maxReapsPerTick && this.hourlyBudgetRemaining() > 0;
            if (canReap) {
              await this.performReap(session, pressure, next); // clears the lease on every path
              reapedThisTick++;
            } else {
              // Grace elapsed but the reap is gated (tier dropped / budget spent).
              // Release the reaping lease so the idle-kill safety net is not
              // permanently disabled for this session.
              this.deps.clearReaping(session.id);
            }
            this.obs.set(session.id, { ...next, reapPendingSince: undefined });
          } else {
            this.obs.set(session.id, next); // keep waiting out the grace window
          }
          continue;
        }

        // Not yet reap-pending. Need: hysteresis satisfied + idle past threshold
        // + pressure tier permits reaping + budget available.
        const hysteresisOk = consecutive >= this.cfg.confirmObservations
          && (now - candidateSince) >= this.cfg.confirmWindowMinutes * 60_000;
        const idleMs = now - candidateSince;
        if (threshold != null && hysteresisOk && idleMs >= threshold
            && reapedThisTick < this.cfg.maxReapsPerTick && this.hourlyBudgetRemaining() > 0) {
          // Enter reap-pending (two-phase). Lease the session so idle-kill won't
          // race us; terminate on a later tick after the grace window.
          next.reapPendingSince = now;
          this.deps.markReaping(session.id);
          this.audit('reap-pending', session, { tier: pressure.tier, idleMs, thresholdMs: threshold });
        }
        this.obs.set(session.id, next);
      }
    } finally {
      this.running = false;
    }
  }

  private async performReap(session: Session, pressure: PressureReading, obs: Obs): Promise<void> {
    const detail = { tier: pressure.tier, idleMs: this.now() - obs.candidateSince, dryRun: !this.killsEnabled };
    if (!this.killsEnabled) {
      this.audit('would-reap', session, detail); // dry-run: log, do not kill
      this.deps.clearReaping(session.id);
      return;
    }
    try {
      const r = await this.deps.terminate(session.id, 'reaped-idle');
      if (r.terminated) {
        this.reapTimestamps.push(this.now());
        this.audit('reaped', session, detail);
        this.emit('reaped', session);
      } else {
        // Ambiguous outcome (already gone, protected, in-flight) — fail safe.
        this.autoDisabled = true;
        this.audit('reap-skipped-auto-disable', session, { ...detail, skipped: r.skipped });
        this.emit('auto-disabled', { session, reason: r.skipped });
      }
    } catch (err) {
      this.autoDisabled = true;
      this.audit('reap-failed-auto-disable', session, { ...detail, error: err instanceof Error ? err.message : String(err) });
      this.emit('auto-disabled', { session, reason: 'error' });
    } finally {
      this.deps.clearReaping(session.id);
    }
  }

  private audit(event: string, session: Session, detail: Record<string, unknown>): void {
    const entry = { ts: new Date(this.now()).toISOString(), kind: 'session-reaper', event, session: session.name, sessionId: session.id, ...detail };
    if (this.deps.audit) this.deps.audit(entry);
  }

  /** Observability snapshot for GET /sessions/reaper. */
  snapshot(): {
    enabled: boolean; dryRun: boolean; autoDisabled: boolean; lastTickAt: number;
    pressure: PressureReading; activeThresholdMinutes: number | null;
    reapsLastHour: number;
    sessions: Array<{ name: string; sessionId: string; verdict: Verdict; keptBy: string; confidence: Confidence; consecutive: number; idleMs: number; reapPending: boolean }>;
  } {
    const pressure = this.deps.pressure();
    const threshold = this.thresholdMs(pressure.tier);
    const now = this.now();
    const sessions = this.deps.listRunningSessions().map(s => {
      const o = this.obs.get(s.id);
      let verdict: Verdict = 'keep';
      let keptBy = 'eval-error';
      let confidence: Confidence = 'low';
      try {
        const e = this.evaluate(s);
        verdict = e.verdict; keptBy = e.keptBy; confidence = e.confidence;
      } catch { /* a protect-signal threw — report as kept, never crash the route */ }
      return {
        name: s.name, sessionId: s.id, verdict, keptBy, confidence,
        consecutive: o?.consecutive ?? 0, idleMs: o?.candidateSince ? now - o.candidateSince : 0,
        reapPending: o?.reapPendingSince != null,
      };
    });
    return {
      enabled: this.cfg.enabled, dryRun: this.cfg.dryRun || this.autoDisabled, autoDisabled: this.autoDisabled,
      lastTickAt: this.lastTickAt, pressure,
      activeThresholdMinutes: threshold == null ? null : Math.round(threshold / 60_000),
      reapsLastHour: this.cfg.maxReapsPerHour - this.hourlyBudgetRemaining(),
      sessions,
    };
  }
}

function safeCapture(deps: SessionReaperDeps, tmuxSession: string, lines: number): string {
  try { return deps.captureOutput(tmuxSession, lines) ?? ''; } catch { return ''; }
}

/** Default audit sink: append one JSON line to logs/sentinel-events.jsonl. */
export function fileAuditSink(stateDir: string): (event: Record<string, unknown>) => void {
  const logPath = path.join(stateDir, '..', 'logs', 'sentinel-events.jsonl');
  return (event: Record<string, unknown>) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
    } catch { /* never throw from the audit sink */ }
  };
}
