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

  get promptVersion(): string {
    return PROMPT_VERSION;
  }
}
