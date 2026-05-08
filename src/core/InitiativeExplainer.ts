/**
 * InitiativeExplainer — Haiku-backed plain-English rewriter for initiative
 * titles, descriptions, and digest signals.
 *
 * Why: initiatives are usually written by Echo (the developer agent) in
 * shorthand — "Phase B scope call: gate handlers vs validate Phase A".
 * That's fine for the agent but unreadable for the human user looking at
 * the dashboard. This module reads the structured initiative + active
 * signal and produces:
 *   • summary    — 1-3 plain-English sentences explaining what the
 *                  initiative IS and what it's trying to deliver.
 *   • signalText — a clear, jargon-free version of the current signal,
 *                  written so a non-technical reader knows what's pending
 *                  and why their input is needed.
 *
 * Cached on the initiative itself (`Initiative.userExplanation`). The
 * cache is keyed by a content hash; when description / phase / signal
 * inputs change, the explainer recomputes on the next sweep.
 *
 * Same shape as ThreadlineNicknameSuggester — periodic sweep + on-demand.
 */

import crypto from 'node:crypto';
import type { IntelligenceProvider } from './types.js';
import type {
  Digest,
  DigestItem,
  Initiative,
  InitiativeTracker,
  InitiativeUserExplanation,
} from './InitiativeTracker.js';

export interface InitiativeExplainerOptions {
  tracker: InitiativeTracker;
  /** When omitted or null, the explainer is a no-op. */
  intelligence?: IntelligenceProvider | null;
  /** Cap how many initiatives we explain per run, to bound cost (default 5). */
  maxPerRun?: number;
  /** Optional logger. */
  logger?: (line: string) => void;
}

export interface ExplainRunResult {
  scanned: number;
  applied: Array<{ id: string; sourceHash: string }>;
  skipped: Array<{ id: string; reason: string }>;
  durationMs: number;
}

const DEFAULT_MAX_PER_RUN = 5;
const SUMMARY_MAX_CHARS = 600;
const SIGNAL_MAX_CHARS = 800;

export class InitiativeExplainer {
  private readonly tracker: InitiativeTracker;
  private readonly intelligence: IntelligenceProvider | null;
  private readonly maxPerRun: number;
  private readonly log: (line: string) => void;

  constructor(opts: InitiativeExplainerOptions) {
    this.tracker = opts.tracker;
    this.intelligence = opts.intelligence ?? null;
    this.maxPerRun = opts.maxPerRun ?? DEFAULT_MAX_PER_RUN;
    this.log = opts.logger ?? (() => {});
  }

  isAvailable(): boolean {
    return this.intelligence !== null;
  }

  /**
   * Compute the source-hash for an initiative + signal pair. The cache
   * is keyed by this so we know when to recompute.
   */
  static computeHash(ini: Initiative, signal: DigestItem | null): string {
    const phase = ini.phases[ini.currentPhaseIndex];
    const parts = [
      ini.title,
      ini.description,
      phase?.id ?? '',
      phase?.name ?? '',
      phase?.status ?? '',
      signal ? `${signal.reason}|${signal.detail}` : 'no-signal',
    ];
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  }

  /** Pick the active signal for an initiative from a digest, if any. */
  static pickSignal(ini: Initiative, digest: Digest | null): DigestItem | null {
    if (!digest) return null;
    return digest.items.find((d) => d.initiativeId === ini.id) ?? null;
  }

  /**
   * Generate (or refresh) the explanation for one initiative.
   * Returns `null` when no explainer is available (no intelligence
   * provider) or when the cached version is still fresh.
   */
  async explainOne(
    ini: Initiative,
    signal: DigestItem | null,
    opts?: { force?: boolean },
  ): Promise<InitiativeUserExplanation | null> {
    if (!this.intelligence) return null;
    const sourceHash = InitiativeExplainer.computeHash(ini, signal);
    if (!opts?.force && ini.userExplanation?.sourceHash === sourceHash) {
      return ini.userExplanation;
    }
    const prompt = buildPrompt(ini, signal);
    let raw = '';
    try {
      raw = await this.intelligence.evaluate(prompt, {
        model: 'fast',
        maxTokens: 600,
        temperature: 0.2,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[initiative-explainer] ${ini.id} evaluate failed: ${reason}`);
      throw err;
    }
    const parsed = parseExplanation(raw);
    if (!parsed.summary) {
      this.log(`[initiative-explainer] ${ini.id} parse produced no summary`);
      return null;
    }
    const explanation: InitiativeUserExplanation = {
      summary: clip(parsed.summary, SUMMARY_MAX_CHARS),
      signalText: signal ? clip(parsed.signalText, SIGNAL_MAX_CHARS) : '',
      generatedAt: new Date().toISOString(),
      sourceHash,
    };
    this.tracker.setUserExplanation(ini.id, explanation);
    this.log(`[initiative-explainer] ${ini.id} updated (hash=${sourceHash})`);
    return explanation;
  }

  /**
   * Sweep every initiative; skip ones whose cached explanation matches
   * the current source-hash. Cap to maxPerRun to bound cost.
   */
  async run(opts?: { force?: boolean; max?: number }): Promise<ExplainRunResult> {
    const startedAt = Date.now();
    const applied: ExplainRunResult['applied'] = [];
    const skipped: ExplainRunResult['skipped'] = [];

    if (!this.intelligence) {
      return {
        scanned: 0,
        applied,
        skipped: [{ id: '*', reason: 'no intelligence provider configured' }],
        durationMs: Date.now() - startedAt,
      };
    }

    const cap = Math.min(opts?.max ?? this.maxPerRun, 50);
    const initiatives = this.tracker.list();
    const digest = this.tracker.digest();
    let processed = 0;

    for (const ini of initiatives) {
      if (processed >= cap) {
        skipped.push({ id: ini.id, reason: 'cap reached for this run' });
        continue;
      }
      const signal = InitiativeExplainer.pickSignal(ini, digest);
      const sourceHash = InitiativeExplainer.computeHash(ini, signal);
      if (!opts?.force && ini.userExplanation?.sourceHash === sourceHash) {
        skipped.push({ id: ini.id, reason: 'cached explanation still fresh' });
        continue;
      }
      try {
        const result = await this.explainOne(ini, signal, { force: !!opts?.force });
        if (result) {
          processed++;
          applied.push({ id: ini.id, sourceHash: result.sourceHash });
        } else {
          skipped.push({ id: ini.id, reason: 'explainer returned null' });
        }
      } catch (err) {
        skipped.push({ id: ini.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      scanned: initiatives.length,
      applied,
      skipped,
      durationMs: Date.now() - startedAt,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildPrompt(ini: Initiative, signal: DigestItem | null): string {
  const phase = ini.phases[ini.currentPhaseIndex];
  const phaseLine = phase
    ? `Current phase: ${phase.name} (status: ${phase.status})`
    : 'Current phase: (none)';
  const allPhases = ini.phases
    .map((p, i) => `  ${i + 1}. ${p.name} — ${p.status}`)
    .join('\n');
  const blockers = ini.blockers?.length
    ? `Blockers: ${ini.blockers.join('; ')}`
    : 'Blockers: (none)';
  const signalBlock = signal
    ? [
        '',
        `Active signal: ${signal.reason}`,
        `Signal detail (developer shorthand): ${signal.detail}`,
      ].join('\n')
    : '\nActive signal: (none — no current question for the user)';
  return [
    'You are rewriting a developer-shorthand initiative for a non-technical reader who is glancing at a dashboard.',
    '',
    'INPUTS:',
    `Title: ${ini.title}`,
    `Description (developer shorthand): ${ini.description}`,
    phaseLine,
    'All phases:',
    allPhases,
    blockers,
    signalBlock,
    '',
    'OUTPUT — return EXACTLY two labelled blocks, no other text:',
    '',
    'SUMMARY:',
    '<2-3 plain-English sentences. Explain what this initiative IS and what it is trying to deliver. Skip code/tooling jargon, expand acronyms on first use, replace arrows like "A→B→C" with prose. Aim for someone who has never seen the codebase.>',
    '',
    'SIGNAL:',
    signal
      ? '<2-3 plain-English sentences. Explain what is currently pending, what input is needed from the reader, and why it matters. If the signal is a question, restate it clearly. If the signal is just "stale" or "ready to advance", say what the next step is. No internal phase codes — refer to phases by their name. Empty if no signal.>'
      : '<empty — there is no active signal>',
  ].join('\n');
}

function parseExplanation(raw: string): { summary: string; signalText: string } {
  if (!raw) return { summary: '', signalText: '' };
  const text = String(raw).trim();
  // Match labelled blocks. Tolerant of casing, extra punctuation.
  const summaryMatch = text.match(/SUMMARY\s*:\s*([\s\S]*?)(?:\n\s*SIGNAL\s*:|$)/i);
  const signalMatch = text.match(/SIGNAL\s*:\s*([\s\S]*?)\s*$/i);
  const summary = (summaryMatch?.[1] ?? '').trim();
  const signalText = (signalMatch?.[1] ?? '').trim();
  return {
    summary: cleanBlock(summary),
    signalText: cleanBlock(signalText),
  };
}

function cleanBlock(s: string): string {
  if (!s) return '';
  return s
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trim() + '…';
}
