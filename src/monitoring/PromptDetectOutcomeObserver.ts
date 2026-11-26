/**
 * PromptDetectOutcomeObserver — the terminal-input outcome label for
 * PromptGate's blocking-prompt detector (CMT-1677).
 *
 * After the detector classifies a pane snapshot, nothing used to record what
 * the pane did next, so neither the incumbent nor the Jev shadow could ever be
 * graded. This observer watches ONE snapshot per session, in memory, for a
 * bounded horizon H and records exactly one outcome row through the existing
 * decision-quality annotate chokepoint, keyed by the incumbent's
 * router-minted correlation id (the seam identity — no parallel id is minted).
 *
 * SIGNAL ONLY: it never sends keys, never blocks, never changes what
 * PromptGate acts on. Every failure is swallowed.
 *
 * Outcome kinds and what they prove:
 *   - progressed-without-input — the bottom of the pane changed and no input
 *     was sent. Tool evidence the pane was NOT blocking (rule
 *     terminal-prompt-progressed-v1). The only kind that grades right/wrong.
 *   - input-while-unchanged — input was sent while the bottom was still the
 *     same. Candidate evidence it WAS blocking, not proof → unknown.
 *   - unchanged-no-input — nothing changed and no input within H → unknown.
 *   - session-ended / observer-lost — unresolved → unknown.
 * Missing means unknown, never a pass.
 */

// RULE 3: EXEMPT — not a provider/CLI state-detector: it parses no framework
// output. It compares a content-free hash of the pane's bottom five lines with
// the hash at snapshot time ("did anything change?"), which is framework-
// agnostic and has no upstream text to drift. Rule 3.1 rationale, for the record:
//   Criticality: non-critical — its output is an `unknown`-by-default grade on
//     the decision-quality read surface; nothing acts on it.
//   Frequency: per-capture (a Map lookup + hash compare), per detector snapshot.
//   Stability: very-stable (hash inequality; no glyphs, no copy).
//   Fallback: the evidence strength is `negative-evidence`; a missing outcome reads unknown.
//   → Verdict: exempt.
import type {
  DecisionOutcomeAnnotationInput,
  DecisionOutcomeAnnotationResult,
} from '../core/DecisionQualityRecorderImpl.js';
import { DP_TERMINAL_PROMPT_DETECT, TERMINAL_PROMPT_OUTCOME_HORIZON_MS } from '../data/provenanceCoverage.js';

export const PROMPT_DETECT_OUTCOME_COMPONENT = 'PromptGate';
export const TERMINAL_PROMPT_PROGRESSED_RULE_ID = 'terminal-prompt-progressed-v1';
export const TERMINAL_PROMPT_UNRESOLVED_RULE_ID = 'terminal-prompt-unresolved-v1';

export type PromptDetectOutcomeKind =
  | 'progressed-without-input'
  | 'input-while-unchanged'
  | 'unchanged-no-input'
  | 'session-ended'
  | 'observer-lost';

export type PromptDetectEvidenceClass = 'tool' | 'candidate' | 'unresolved';

/** The detector's verdict on the snapshot: blocking, not blocking, or unknown (the call failed). */
export type IncumbentVerdict = 'blocking' | 'no-prompt' | 'unknown';

export interface PromptDetectOutcome {
  correlationId: string;
  sessionName: string;
  kind: PromptDetectOutcomeKind;
  evidenceClass: PromptDetectEvidenceClass;
  incumbent: IncumbentVerdict;
  grade: 'right' | 'wrong' | 'unknown';
  ruleId: string;
  elapsedMs: number;
  /** Why an observer-lost row was written (cap eviction, superseded, disposed). */
  lostReason?: 'evicted' | 'superseded' | 'disposed';
}

export interface PromptDetectOutcomeObserverOptions {
  annotate: (a: DecisionOutcomeAnnotationInput) => DecisionOutcomeAnnotationResult | void;
  now?: () => number;
  horizonMs?: number;
  /** Bound on tracked sessions; the oldest is dropped with an observer-lost row. */
  maxSessions?: number;
  /** Test/telemetry seam: every recorded outcome. */
  onOutcome?: (o: PromptDetectOutcome) => void;
}

interface Tracked {
  correlationId: string;
  sessionName: string;
  bottomFingerprint: string;
  startedAt: number;
  incumbent: IncumbentVerdict;
  /** False until the incumbent call settles (its decision row is written then). */
  verdictKnown: boolean;
  /**
   * The first pane/input event seen while the verdict was still pending. It is
   * held, not recorded, so the grade can use the verdict and the outcome never
   * lands before its decision row. Later events are ignored (first wins).
   */
  held?: { kind: 'progressed-without-input' | 'input-while-unchanged'; at: number };
}

export const PROMPT_DETECT_OBSERVER_MAX_SESSIONS = 64;

export class PromptDetectOutcomeObserver {
  private readonly tracked = new Map<string, Tracked>();
  private readonly now: () => number;
  private readonly horizonMs: number;
  private readonly maxSessions: number;
  readonly counters = { tracked: 0, recorded: 0, annotateErrors: 0, notApplied: 0 };

  constructor(private readonly opts: PromptDetectOutcomeObserverOptions) {
    this.now = opts.now ?? Date.now;
    this.horizonMs = opts.horizonMs ?? TERMINAL_PROMPT_OUTCOME_HORIZON_MS;
    this.maxSessions = Math.max(1, opts.maxSessions ?? PROMPT_DETECT_OBSERVER_MAX_SESSIONS);
  }

  /** Number of sessions currently observed (bounded by maxSessions). */
  size(): number {
    return this.tracked.size;
  }

  /** Begin observing a detector snapshot. One observation per session. */
  track(input: { sessionName: string; correlationId: string; bottomFingerprint: string; startedAt?: number }): void {
    if (!input.correlationId) return; // never fabricate a join key
    const prior = this.tracked.get(input.sessionName);
    if (prior) {
      if (prior.correlationId === input.correlationId) return;
      this.finish(prior, 'observer-lost', 'superseded');
    }
    while (this.tracked.size >= this.maxSessions) {
      const oldest = this.tracked.values().next().value as Tracked | undefined;
      if (!oldest) break;
      this.finish(oldest, 'observer-lost', 'evicted');
    }
    this.tracked.set(input.sessionName, {
      correlationId: input.correlationId,
      sessionName: input.sessionName,
      bottomFingerprint: input.bottomFingerprint,
      startedAt: input.startedAt ?? this.now(),
      incumbent: 'unknown',
      verdictKnown: false,
    });
    this.counters.tracked++;
  }

  /**
   * The incumbent call settled for this correlation id ('unknown' = it
   * failed). A held event is recorded now, with the verdict.
   */
  setIncumbent(sessionName: string, correlationId: string, verdict: IncumbentVerdict): void {
    const t = this.tracked.get(sessionName);
    if (!t || t.correlationId !== correlationId || t.verdictKnown) return;
    t.incumbent = verdict;
    t.verdictKnown = true;
    if (t.held) this.finish(t, t.held.kind, undefined, t.held.at);
  }

  /** A fresh pane capture. Also expires every observation past the horizon. */
  onPane(sessionName: string, bottomFingerprint: string): void {
    this.sweep();
    const t = this.tracked.get(sessionName);
    if (t && t.bottomFingerprint !== bottomFingerprint) this.event(t, 'progressed-without-input');
  }

  /** Input was sent to the session. */
  onInput(sessionName: string): void {
    this.sweep();
    const t = this.tracked.get(sessionName);
    if (t) this.event(t, 'input-while-unchanged');
  }

  private event(t: Tracked, kind: 'progressed-without-input' | 'input-while-unchanged'): void {
    if (t.verdictKnown) { this.finish(t, kind); return; }
    if (!t.held) t.held = { kind, at: this.now() };
  }

  /** The session ended. */
  onSessionEnded(sessionName: string): void {
    const t = this.tracked.get(sessionName);
    if (t) this.finish(t, 'session-ended');
  }

  /** Close every observation past the horizon as unchanged-no-input. */
  sweep(): void {
    const now = this.now();
    for (const t of [...this.tracked.values()]) {
      if (now - t.startedAt < this.horizonMs) continue;
      // The verdict never arrived: a held event is still recorded (ungraded).
      if (t.held) this.finish(t, t.held.kind, undefined, t.held.at);
      else this.finish(t, 'unchanged-no-input');
    }
  }

  /** Shutdown: every open observation becomes observer-lost. */
  dispose(): void {
    for (const t of [...this.tracked.values()]) this.finish(t, 'observer-lost', 'disposed');
  }

  private finish(t: Tracked, kind: PromptDetectOutcomeKind, lostReason?: PromptDetectOutcome['lostReason'], at?: number): void {
    this.tracked.delete(t.sessionName);
    const progressed = kind === 'progressed-without-input';
    const evidenceClass: PromptDetectEvidenceClass = progressed ? 'tool' : kind === 'input-while-unchanged' ? 'candidate' : 'unresolved';
    // Only tool evidence grades; it says "not blocking", so a no-prompt verdict
    // was right and a blocking verdict was wrong. An unknown verdict stays unknown.
    const grade: PromptDetectOutcome['grade'] = progressed && t.incumbent !== 'unknown'
      ? (t.incumbent === 'no-prompt' ? 'right' : 'wrong')
      : 'unknown';
    const ruleId = progressed ? TERMINAL_PROMPT_PROGRESSED_RULE_ID : TERMINAL_PROMPT_UNRESOLVED_RULE_ID;
    const elapsedMs = Math.max(0, (at ?? this.now()) - t.startedAt);
    const outcome: PromptDetectOutcome = {
      correlationId: t.correlationId, sessionName: t.sessionName, kind, evidenceClass,
      incumbent: t.incumbent, grade, ruleId, elapsedMs, ...(lostReason ? { lostReason } : {}),
    };
    try {
      const res = this.opts.annotate({
        correlationId: t.correlationId,
        ruleId,
        gradedBy: { component: PROMPT_DETECT_OUTCOME_COMPONENT },
        grade,
        decisionPoint: DP_TERMINAL_PROMPT_DETECT,
        // Content-free: ids, enums and numbers only — never pane text.
        evidence: {
          kind: 'terminal-prompt-outcome', outcomeKind: kind, evidenceClass,
          incumbent: t.incumbent, elapsedMs, horizonMs: this.horizonMs,
          ...(lostReason ? { lostReason } : {}),
        },
      });
      if (res && !res.applied) this.counters.notApplied++;
    } catch {
      // @silent-fallback-ok: an outcome write is observability; it must never
      // break the capture tick it observes. Counted in annotateErrors.
      this.counters.annotateErrors++;
    }
    this.counters.recorded++;
    try { this.opts.onOutcome?.(outcome); } catch { /* @silent-fallback-ok — test/telemetry seam */ }
  }
}
