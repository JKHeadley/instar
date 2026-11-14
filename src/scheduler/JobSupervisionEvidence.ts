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
  const lines = [`job: ${job.slug}`, `result: ${parsed.result}`, `reasonCode: ${parsed.reasonCode || 'none'}`];
  if (parsed.droppedFields > 0) lines.push(`rejected-fields: ${Math.min(parsed.droppedFields, 16)}`);
  for (const anomaly of parsed.anomalies) {
    lines.push(`anomaly: ${anomaly.kind} severity=${anomaly.severity} class=${anomaly.class}`);
  }
  const allowed = new Set(job.triageFields ?? []);
  for (const [key, value] of Object.entries(parsed.fields).sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowed.has(key)) return { ok: false, reason: 'unknown-field' };
    const cleaned = scrubForStore(value);
    if (cleaned.error) return { ok: false, reason: 'evidence-withheld' };
    lines.push(`field ${key}: ${cleaned.text.slice(0, 200)}`);
  }
  // Free text is opt-in per job. Structured-only and undeclared policies
  // never send the output tail to an external provider.
  if (job.triageEvidence === 'full') {
    if (/PRIVATE KEY-----/.test(input.scrubbedOutput)) return { ok: false, reason: 'evidence-withheld' };
    const cleaned = scrubForStore(input.scrubbedOutput);
    if (cleaned.error) return { ok: false, reason: 'evidence-withheld' };
    lines.push(`output-tail: ${Array.from(cleaned.text).slice(-1000).join('')}`);
  }
  const signal = input.independentSignal;
  const signalFresh = independentSignalIsFresh(signal, job.slug, input.now ?? Date.now());
  if (signalFresh) lines.push(`independent-signal: ${signal!.source} ${signal!.status} ${signal!.observedAt}`);
  const text = lines.join('\n');
  if (Array.from(text).length > SUPERVISION_EVIDENCE_MAX_CHARS) {
    return { ok: false, reason: 'evidence-over-cap' };
  }
  return { ok: true, text, hash: crypto.createHash('sha256').update(text).digest('hex'),
    sufficientForRoutine: parsed.droppedFields === 0 && signalFresh && signal?.status === 'healthy',
    policy: SUPERVISION_EVIDENCE_POLICY };
}
