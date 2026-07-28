/**
 * MentorStageBForensics — the "look under the hood" analysis of Stage B
 * (FRAMEWORK-ONBOARDING-MENTOR-SPEC §3.2, §19.4 deep-forensics follow-on).
 *
 * After Stage A drives the mentee, Stage B reads the mentee's actual signals
 * (recent rollout/session activity + server-log errors/sentinel events) and
 * classifies what went wrong into the three buckets, writing findings to the
 * ledger. This module is the PURE core: prompt assembly + defensive parsing of
 * the LLM's classification. The I/O (reading rollouts/logs) and the LLM call are
 * injected, so it's fully unit-testable without an LLM or the filesystem.
 *
 * Signal-only: produces ForensicFinding[] for the ledger; never gates or acts.
 */
import {
  ISSUE_BUCKETS,
  ISSUE_SEVERITIES,
  type IssueBucket,
  type IssueSeverity,
  type ForensicFinding,
} from '../monitoring/FrameworkIssueLedger.js';

const MAX_FINDINGS_PER_RUN = 10; // bound a single tick's output
const MAX_TITLE = 200;

/** A normalized slug for a dedupKey from a model-supplied stable id (keeps it as-is, kebabed). */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

/**
 * Derive a conservative dedupKey from a title when the model omits one. Strips
 * VOLATILE tokens that would split one issue across runs — standalone numbers,
 * timeout/percent/version literals, and hex-ish ids — keeping only the stable
 * symptom words. (§13.3: titles are operator-dependent; this is the last-resort
 * fallback — the prompt asks the model for a stable id directly.)
 */
function deriveStableSlug(title: string): string {
  const stable = title
    .toLowerCase()
    .replace(/\bv?\d+(?:\.\d+)+\b/g, ' ') // version strings (v1.3.14, 1.2.3)
    .replace(/\b\d+\s*(?:ms|s|m|h|%|k|kb|mb|tokens?|turns?)\b/g, ' ') // 8s, 42%, 15k, 1 turn
    .replace(/\b[0-9a-f]{6,}\b/g, ' ') // hex ids / shas
    .replace(/\b\d+\b/g, ' ') // any remaining standalone numbers
    .replace(/\s+/g, ' ')
    .trim();
  return slug(stable || title);
}

/**
 * Build the Stage-B forensic prompt. The model is asked to classify ONLY what
 * the signals actually evidence into the three buckets, and to output a strict
 * JSON array — no prose. Conservative by instruction: report nothing rather than
 * speculate (false findings poison the ledger/playbook).
 */
export function buildForensicPrompt(framework: string, signals: string): string {
  return [
    `You are the "developer hat" of a framework-onboarding mentor, doing forensics on the agent`,
    `framework "${framework}". Below are real signals from its recent activity (logs, session`,
    `usage, errors). Identify concrete behavioral issues these signals EVIDENCE — do not speculate.`,
    `Classify each into exactly one bucket:`,
    `  - "framework-limitation": the engine's own limit (e.g. argv overflow, context truncation)`,
    `  - "instar-integration-gap": Instar not fitting this engine right (a wiring/config defect)`,
    `  - "generic-agent-mistake": a one-off mistake any agent could make`,
    ``,
    `Output ONLY a JSON array (no markdown, no prose). Each element:`,
    `  {"bucket": "...", "title": "<short>", "severity": "low|medium|high", "dedupKey": "<stable-id>"}`,
    ``,
    `CRITICAL — the dedupKey must be STABLE across runs. It is a short lowercase-kebab identifier`,
    `for the ROOT SYMPTOM, NOT a rephrasing of your title. Use the SAME id you would use if you saw`,
    `this exact issue again next time. Base it on the symptom class + the component, e.g.`,
    `"feedback-webhook-429", "inputguard-review-timeout", "codex-single-turn-exit". Do NOT put`,
    `version numbers, timestamps, session ids, counts, or wording variations in the dedupKey —`,
    `those drift and would split one issue into many. Two reports of the same root problem MUST`,
    `produce the same dedupKey.`,
    ``,
    `If the signals evidence no concrete issue, output []. Never invent issues.`,
    ``,
    `--- Signals ---`,
    signals.slice(0, 12000), // bound the prompt
  ].join('\n');
}

/**
 * Parse the model's forensic output into validated findings. Defensive: tolerates
 * markdown fences / surrounding prose, drops malformed or invalid-enum entries,
 * caps count + field lengths, and derives a conservative dedupKey when the model
 * omits one. Returns [] on any parse failure (never throws — a bad forensic read
 * must not crash a tick).
 */
export function parseForensicFindings(raw: string, framework: string): ForensicFinding[] {
  if (!raw || !raw.trim()) return [];
  // Extract the first JSON array in the output (tolerate ```json fences / prose).
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ForensicFinding[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_FINDINGS_PER_RUN) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const bucket = o.bucket as string;
    if (!ISSUE_BUCKETS.includes(bucket as IssueBucket)) continue; // drop invalid bucket
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE) : '';
    if (!title) continue;
    const severity: IssueSeverity = ISSUE_SEVERITIES.includes(o.severity as IssueSeverity)
      ? (o.severity as IssueSeverity)
      : 'medium';
    const dedupKey =
      typeof o.dedupKey === 'string' && o.dedupKey.trim()
        ? `${framework}::${slug(o.dedupKey)}`
        : `${framework}::${deriveStableSlug(title)}`;
    out.push({ bucket: bucket as IssueBucket, title, severity, dedupKey, signature: title });
  }
  return out;
}

export interface AnalyzeForensicsInput {
  framework: string;
  /** Assembled forensic signals (log tail + session digest). Empty ⇒ no findings. */
  signals: string;
  /** The LLM call (injected — IntelligenceProvider.evaluate in production). */
  evaluate: (prompt: string) => Promise<string>;
}

/**
 * Run the Stage-B forensic analysis: classify the assembled signals into findings.
 * Returns [] when there are no signals (nothing observed this tick) so the tick
 * still records a run in the funnel. Never throws.
 */
export async function analyzeForensics(input: AnalyzeForensicsInput): Promise<ForensicFinding[]> {
  if (!input.signals || !input.signals.trim()) return [];
  let raw: string;
  try {
    raw = await input.evaluate(buildForensicPrompt(input.framework, input.signals));
  } catch {
    return []; // a failed forensic LLM call is a no-op tick, not a crash
  }
  return parseForensicFindings(raw, input.framework);
}
