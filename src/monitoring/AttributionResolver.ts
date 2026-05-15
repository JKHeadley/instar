/**
 * AttributionResolver — read-side resolver for the burn-detection system.
 *
 * Phase 2 of docs/specs/token-burn-detection-and-self-heal.md.
 *
 * Pure function: given the shape of a TokenLedger event (sessionId, cwd,
 * prompt text, model) returns an attribution_key suitable for grouping
 * "calls of the same structural origin." Used by the Phase 3 BurnDetector
 * to populate attribution_key for events the Phase 1 chokepoint did NOT
 * write directly — chiefly the dominant Claude-CLI path where the JSONL
 * trail carries the prompt and cwd but no source-side label.
 *
 * Authority shape: this is signal-only. It does not gate, throttle, or
 * decide anything. It maps event → key. The detector emits, the
 * Remediator decides. See umbrella spec §"Signal-vs-Authority Decomposition".
 *
 * No I/O, no time-dependent behavior — deterministic for tests + reasoning.
 */

import { buildAttributionKey } from './attributionKey.js';
import { ATTRIBUTION_MANIFEST, type AttributionPattern } from './attribution-manifest.js';

export interface AttributionEvent {
  sessionId: string;
  /** cwd / projectPath field from the JSONL line. */
  projectPath?: string | null;
  /** The user prompt that triggered the assistant response. Optional — when missing, resolver falls back to cwd / unknown. */
  prompt?: string | null;
  /** Model string from the JSONL line (`message.model`). */
  model?: string | null;
}

/**
 * Resolve an attribution_key for an event.
 *
 * Resolution order:
 *   1. Manifest entry that matches the prompt (with optional cwd / model
 *      narrowing) → `<component>::<promptFingerprint>`.
 *   2. cwd-based scheduled-job inference — if the cwd contains a path
 *      segment like `.instar/jobs/<name>`, return `user-job:<name>`.
 *   3. cwd-based user-extension inference — if the cwd contains
 *      `.claude/hooks/` or `.instar/hooks/`, return the hook filename.
 *   4. Fallback: `unknown::<sessionId-prefix>`.
 *
 * The prompt-based check is intentionally first: it's the most informative
 * signal for the bleed-detection use case (one prompt shape running tens
 * of thousands of times). cwd-based inference is the secondary signal for
 * cases where the prompt is variable but the source is recognisable.
 */
export function resolveAttribution(event: AttributionEvent): string {
  // 1. Manifest-based prompt match (with optional cwd/model narrowing).
  if (event.prompt && event.prompt.length > 0) {
    for (const entry of ATTRIBUTION_MANIFEST) {
      if (matchesEntry(entry, event)) {
        return buildAttributionKey(entry.component, event.prompt);
      }
    }
  }

  // 2. Scheduled-job inference: a path segment of the cwd is the job name.
  //    e.g. /Users/x/.instar/jobs/daily-summary → user-job:daily-summary
  if (event.projectPath) {
    const jobMatch = event.projectPath.match(/[/\\]\.instar[/\\]jobs[/\\]([^/\\]+)/);
    if (jobMatch && jobMatch[1]) {
      return `user-job:${jobMatch[1]}::${shortPromptFp(event.prompt)}`;
    }

    // 3. Hook / extension inference.
    const hookMatch = event.projectPath.match(/[/\\](?:\.claude|\.instar)[/\\]hooks[/\\]([^/\\]+)/);
    if (hookMatch && hookMatch[1]) {
      return `user-hook:${hookMatch[1]}::${shortPromptFp(event.prompt)}`;
    }
  }

  // 4. Fallback. Use a stable session-id prefix so a single misbehaving
  //    session shows as one key (and not exploded by per-prompt fingerprint).
  if (!event.sessionId || event.sessionId.length === 0) {
    return 'unknown::no-session';
  }
  const sidPrefix = event.sessionId.slice(0, 8);
  return `unknown::${sidPrefix}`;
}

function matchesEntry(entry: AttributionPattern, event: AttributionEvent): boolean {
  // Prompt must match if patterns are defined (Phase 2 always defines them).
  if (entry.promptPatterns && entry.promptPatterns.length > 0) {
    if (!event.prompt) return false;
    const hit = entry.promptPatterns.some((re) => re.test(event.prompt!));
    if (!hit) return false;
  }
  // Optional cwd narrowing.
  if (entry.cwdPatterns && entry.cwdPatterns.length > 0) {
    if (!event.projectPath) return false;
    const hit = entry.cwdPatterns.some((re) => re.test(event.projectPath!));
    if (!hit) return false;
  }
  // Optional model narrowing.
  if (entry.modelHints && entry.modelHints.length > 0) {
    if (!event.model) return false;
    const hit = entry.modelHints.some((m) => event.model!.includes(m));
    if (!hit) return false;
  }
  return true;
}

function shortPromptFp(prompt: string | null | undefined): string {
  if (!prompt || prompt.length === 0) return 'nonprompt';
  // Cheap deterministic fingerprint without importing crypto on every call.
  // Phase 1's buildAttributionKey covers the cryptographic case; here we
  // only need to disambiguate prompts at the user-job / user-hook level.
  let h = 0;
  const slice = prompt.slice(0, 128);
  for (let i = 0; i < slice.length; i++) h = ((h << 5) - h + slice.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}
