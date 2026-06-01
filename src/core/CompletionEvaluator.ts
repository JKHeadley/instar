/**
 * CompletionEvaluator — independent "is the autonomous goal met?" judge.
 *
 * Replaces the autonomous stop-hook's self-declared `<promise>` check with an
 * INDEPENDENT judgment: a small/fast model decides whether a verifiable
 * completion CONDITION is met, judging only what the agent has surfaced in the
 * recent transcript (it does not run tools — same contract as the framework
 * `/goal` feature this mirrors). "Not met" returns a reason that the hook feeds
 * back as next-turn guidance.
 *
 * This is the loop's continue/stop authority — a full-context model judgment
 * (condition + transcript), not a brittle low-context filter. Runs on the
 * shared IntelligenceProvider (Claude/Codex subscription or API), `fast` tier,
 * spend-capped upstream by LlmQueue.
 *
 * Spec: docs/specs/goal-completion-evaluator.md
 */

import type { IntelligenceProvider } from './types.js';

export interface CompletionVerdict {
  /** Whether the condition is met (the loop may stop). */
  met: boolean;
  /** One-line reason — fed back as next-turn guidance when not met. */
  reason: string;
}

/**
 * Verdict for the P13 "The Stop Reason Is the Work" guard. SECONDARY to the
 * completion check: it does not decide whether the goal is done, only whether a
 * stop-attempt rests on the P13 anti-pattern (ending an autonomous run because
 * "I need a judgment call" or "this needs real engineering" — a derivable
 * standard or a buildable artifact dressed up as a stop reason).
 */
export interface StopRationaleVerdict {
  /** Whether the autonomous run may stop (no P13 violation detected). */
  stopAllowed: boolean;
  /** One-line P13 steering, fed back as next-turn guidance when the stop is not allowed. */
  guidance: string;
}

export interface CompletionEvaluatorDeps {
  intelligence: IntelligenceProvider;
  /** Override model tier (default 'fast' — matches /goal's small-fast evaluator). */
  modelTier?: 'fast' | 'balanced' | 'capable';
}

const PROMPT_VERSION = 'completion-eval-v1';

export class CompletionEvaluator {
  private readonly intelligence: IntelligenceProvider;
  private readonly modelTier: 'fast' | 'balanced' | 'capable';

  constructor(deps: CompletionEvaluatorDeps) {
    this.intelligence = deps.intelligence;
    this.modelTier = deps.modelTier ?? 'fast';
  }

  /**
   * Judge whether `condition` is met given the recent transcript text.
   * Robust to model phrasing: looks for an explicit MET/NOT_MET verdict.
   * On any error/ambiguity, returns `met:false` — never falsely "done" (the
   * caller treats "not met" as keep-working, which is the safe direction).
   */
  async evaluate(condition: string, transcriptTail: string): Promise<CompletionVerdict> {
    const prompt = this.buildPrompt(condition, transcriptTail);
    let raw: string;
    try {
      raw = await this.intelligence.evaluate(prompt, {
        model: this.modelTier,
        temperature: 0,
        maxTokens: 200,
        timeoutMs: 30_000,
        attribution: { component: 'CompletionEvaluator' },
      });
    } catch (err) {
      return { met: false, reason: `evaluator error (keep working): ${err instanceof Error ? err.message : String(err)}` };
    }
    return this.parse(raw);
  }

  private buildPrompt(condition: string, transcriptTail: string): string {
    return [
      'You are an INDEPENDENT completion checker for an autonomous coding agent.',
      'Decide whether the agent has MET its completion condition, judging ONLY from',
      'evidence the agent has surfaced in the transcript below. Do NOT assume work',
      'that is not shown. If the condition requires a check (e.g. "tests pass") and',
      'the transcript does not show that check succeeding, it is NOT met.',
      '',
      `COMPLETION CONDITION:\n${condition}`,
      '',
      `RECENT TRANSCRIPT (most recent last):\n${transcriptTail}`,
      '',
      'Respond on the FIRST line with exactly "MET" or "NOT_MET", then on the next',
      'line a one-sentence reason. Nothing else.',
    ].join('\n');
  }

  /** Parse the model output into a verdict. Conservative: defaults to not-met. */
  private parse(raw: string): CompletionVerdict {
    const text = (raw || '').trim();
    if (!text) return { met: false, reason: 'empty evaluator response (keep working)' };
    // First non-empty line carries the verdict.
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const first = (lines[0] || '').toUpperCase();
    const reason = (lines[1] || lines[0] || '').slice(0, 300);
    // "NOT_MET"/"NOT MET" must be checked before "MET" (substring).
    if (/\bNOT[_ ]?MET\b/.test(first)) return { met: false, reason: reason || 'condition not yet met' };
    if (/\bMET\b/.test(first)) return { met: true, reason: reason || 'condition met' };
    // Ambiguous → safe direction (keep working).
    return { met: false, reason: `ambiguous verdict, keeping work going: ${text.slice(0, 120)}` };
  }

  /**
   * P13 "The Stop Reason Is the Work" guard. Given the recent transcript, decide
   * whether an autonomous stop-attempt is EARNED, or whether it rests on the P13
   * anti-pattern: ending the run citing "needs a judgment call" or "needs real
   * engineering" WITHOUT showing a derived standard, a built artifact, or a
   * genuinely operator-only residual. Returns stopAllowed:false + guidance when
   * the anti-pattern is detected; otherwise stopAllowed:true.
   *
   * Fails OPEN (stopAllowed:true) on error or ambiguity: this is a SECONDARY guard
   * on top of the completion check, so an evaluator hiccup must never TRAP a
   * genuine completion — the primary completion authority still governs.
   */
  async evaluateStopRationale(transcriptTail: string): Promise<StopRationaleVerdict> {
    const prompt = this.buildStopRationalePrompt(transcriptTail);
    let raw: string;
    try {
      raw = await this.intelligence.evaluate(prompt, {
        model: this.modelTier,
        temperature: 0,
        maxTokens: 200,
        timeoutMs: 30_000,
        attribution: { component: 'CompletionEvaluator/P13' },
      });
    } catch {
      // Fail OPEN — never trap a legitimate completion on an evaluator error.
      return { stopAllowed: true, guidance: '' };
    }
    return this.parseStopRationale(raw);
  }

  private buildStopRationalePrompt(transcriptTail: string): string {
    return [
      'You are a guard for an autonomous coding agent, enforcing the constitutional',
      'standard P13 "The Stop Reason Is the Work." Judge ONLY the transcript below.',
      '',
      'Decide whether the agent is ENDING / STOPPING its autonomous run, and if so,',
      'WHY. The stop is NOT earned (BLOCK it) when the stated reason is essentially',
      '"I need a judgment call from the user" or "this needs real engineering / a',
      'careful build / reverse-engineering" — i.e. a judgment gap (which is a',
      'DERIVABLE standard) or buildable engineering (which the agent can DO) dressed',
      'up as a stop reason.',
      '',
      'The stop IS earned (ALLOW it) when ANY of these is shown in the transcript:',
      '- a DERIVED STANDARD the agent reasoned out and is proceeding under (even if',
      '  flagged for later ratification);',
      '- a BUILT ARTIFACT produced this run (a PR/commit, a spec/file written, a test',
      '  result, a converged artifact handed over for review);',
      "- a genuinely OPERATOR-ONLY residual (a credential/account the user holds, a",
      "  real value/priority/risk judgment that is the user's, a required approval,",
      '  a legal/billing/payment action);',
      '- a DURATION limit reached or an EMERGENCY stop;',
      '- the agent is NOT actually stopping (it is continuing / re-scoping / moving',
      '  to another topic and proceeding).',
      '',
      `RECENT TRANSCRIPT (most recent last):\n${transcriptTail}`,
      '',
      'Respond on the FIRST line with exactly "STOP_OK" or "STOP_BLOCKED", then on',
      'the next line a one-sentence reason / steering. Nothing else.',
    ].join('\n');
  }

  /** Parse the P13 guard output. Conservative: defaults to ALLOW (never trap completion). */
  private parseStopRationale(raw: string): StopRationaleVerdict {
    const text = (raw || '').trim();
    if (!text) return { stopAllowed: true, guidance: '' };
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const first = (lines[0] || '').toUpperCase();
    const reason = (lines[1] || lines[0] || '').slice(0, 300);
    // Check BLOCKED before OK (explicit; they share no substring but keep the order clear).
    if (/\bSTOP[_ ]?BLOCKED\b/.test(first)) {
      return {
        stopAllowed: false,
        guidance: reason || 'P13: the stop rests on a judgment-call / needs-engineering reason — derive+document the standard and proceed, or build the artifact and hand it over; reserve the stop for a genuinely operator-only residual.',
      };
    }
    if (/\bSTOP[_ ]?OK\b/.test(first)) return { stopAllowed: true, guidance: '' };
    // Ambiguous → ALLOW (don't trap a genuine completion on a fuzzy verdict).
    return { stopAllowed: true, guidance: '' };
  }

  get promptVersion(): string {
    return PROMPT_VERSION;
  }
}
