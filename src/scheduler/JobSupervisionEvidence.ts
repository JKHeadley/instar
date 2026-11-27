/** Bounded, versioned evidence sent to the result supervisor. */
import crypto from 'node:crypto';
import type { JobDefinition } from '../core/types.js';
import { scrubForStore } from '../core/durableSecretScrub.js';
import type { ParsedScriptRun } from './jobScriptProtocol.js';

export const SUPERVISION_EVIDENCE_POLICY = 'job-result-structured-v2';
export const SUPERVISION_EVIDENCE_MAX_CHARS = 2000;

export interface IndependentResultSignal {
  source: string;
  observedAt: string;
  /** The source must be a subsystem independent of the script being judged. */
  independentOfSlug: string;
  status: 'healthy' | 'problem';
}

export type SupervisionEvidence =
  | { ok: true; text: string; hash: string; sufficientForRoutine: boolean; policy: string }
  | { ok: false; reason: string };

/**
 * An AI answer cannot make a status-only OK sufficient. This code-owned
 * predicate requires a fresh signal from another subsystem for routine
 * closure; exact fixed certificates are checked separately.
 */
export function independentSignalIsFresh(signal: IndependentResultSignal | null | undefined, slug: string, now: number): boolean {
  if (!signal || signal.independentOfSlug !== slug || !signal.source || signal.source === slug) return false;
  const age = now - Date.parse(signal.observedAt);
  return Number.isFinite(age) && age >= 0 && age <= 10 * 60_000;
}

export function projectSupervisionEvidence(input: {
  job: JobDefinition;
  parsed: ParsedScriptRun;
  scrubbedOutput: string;
  independentSignal?: IndependentResultSignal | null;
  now?: number;
}): SupervisionEvidence {
  const { job, parsed } = input;
  if (parsed.overCap) return { ok: false, reason: 'output-truncated' };
  if (parsed.missingResultLine || parsed.ignoredAnomalies > 0) return { ok: false, reason: 'parser-integrity' };
  const head = [`job: ${job.slug}`, `result: ${parsed.result}`, `reasonCode: ${parsed.reasonCode || 'none'}`];
  if (parsed.droppedFields > 0) head.push(`rejected-fields: ${Math.min(parsed.droppedFields, 16)}`);
  const anomalyLines = parsed.anomalies.map(anomaly =>
    `anomaly: ${anomaly.kind} severity=${anomaly.severity} class=${anomaly.class}`);
  const fieldLines: string[] = [];
  const allowed = new Set(job.triageFields ?? []);
  for (const [key, value] of Object.entries(parsed.fields).sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowed.has(key)) return { ok: false, reason: 'unknown-field' };
    const cleaned = scrubForStore(value);
    if (cleaned.error) return { ok: false, reason: 'evidence-withheld' };
    fieldLines.push(`field ${key}: ${cleaned.text.slice(0, 200)}`);
  }
  // Free text is opt-in per job. Structured-only and undeclared policies
  // never send the output tail to an external provider.
  let tailText: string | null = null;
  if (job.triageEvidence === 'full') {
    if (/PRIVATE KEY-----/.test(input.scrubbedOutput)) return { ok: false, reason: 'evidence-withheld' };
    const cleaned = scrubForStore(input.scrubbedOutput);
    if (cleaned.error) return { ok: false, reason: 'evidence-withheld' };
    tailText = cleaned.text;
  }
  const signal = input.independentSignal;
  const signalFresh = independentSignalIsFresh(signal, job.slug, input.now ?? Date.now());
  const signalLines = signalFresh ? [`independent-signal: ${signal!.source} ${signal!.status} ${signal!.observedAt}`] : [];

  // Fit the cap without hiding anything silently (CMT-1610). A healthy job that
  // reports many conditions used to overflow the cap and put its script route
  // on a supervision hold. The head, fields and signal are always kept; then as
  // many anomaly lines as fit, with an explicit omitted count for the rest; the
  // free-text tail takes whatever room is left. Omitted anomalies make the
  // evidence insufficient for routine closure, so the supervisor still judges.
  const len = (l: string[]): number => (l.length === 0 ? 0 : Array.from(l.join('\n')).length);
  const required = [...head, ...fieldLines, ...signalLines];
  if (len(required) > SUPERVISION_EVIDENCE_MAX_CHARS) return { ok: false, reason: 'evidence-over-cap' };
  let kept = anomalyLines.length;
  const omittedLine = (n: number): string[] => (n > 0 ? [`anomalies-omitted: ${n} of ${anomalyLines.length}`] : []);
  const assemble = (n: number, tail: string[]): string[] =>
    [...head, ...anomalyLines.slice(0, n), ...omittedLine(anomalyLines.length - n), ...fieldLines, ...tail, ...signalLines];
  while (kept > 0 && len(assemble(kept, [])) > SUPERVISION_EVIDENCE_MAX_CHARS) kept--;
  if (len(assemble(kept, [])) > SUPERVISION_EVIDENCE_MAX_CHARS) return { ok: false, reason: 'evidence-over-cap' };
  let tail: string[] = [];
  if (tailText !== null) {
    const room = Math.min(1000,
      SUPERVISION_EVIDENCE_MAX_CHARS - len(assemble(kept, [])) - Array.from('\noutput-tail: ').length);
    if (room > 0) tail = [`output-tail: ${Array.from(tailText).slice(-room).join('')}`];
  }
  const lines = assemble(kept, tail);
  const text = lines.join('\n');
  const anomaliesOmitted = kept < anomalyLines.length;
  return { ok: true, text, hash: crypto.createHash('sha256').update(text).digest('hex'),
    sufficientForRoutine: parsed.droppedFields === 0 && !anomaliesOmitted && signalFresh && signal?.status === 'healthy',
    policy: SUPERVISION_EVIDENCE_POLICY };
}
