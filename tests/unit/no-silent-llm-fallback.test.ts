/**
 * no-silent-llm-fallback — enforcement lint for the constitution standard
 * "No Silent Degradation to Brittle Fallback" (docs/specs/no-silent-degradation-to-brittle-fallback.md).
 *
 * THE RULE: when an LLM makes a judgment that GATES an action, a provider failure
 * (rate-limit / circuit-open / error) must NEVER silently drop to a brittle heuristic.
 * It must instead SWAP PROVIDER (handled centrally by IntelligenceRouter.failureSwap
 * for `gating: true` calls) or FAIL CLOSED, and the degradation must be REPORTED
 * (DegradationReporter) rather than swallowed.
 *
 * This test is the forward ratchet: every file that calls an IntelligenceProvider
 * `.evaluate()` must carry ONE of the accepted safety markers, OR be explicitly
 * listed in REVIEWED_ADVISORY with a reason (audited: its degradation is benign —
 * it informs, it does not gate a dangerous/irreversible action). A NEW LLM callsite
 * that is neither marked nor reviewed FAILS this test — forcing the author to triage
 * it (swap / fail-closed / report / classify-as-advisory) instead of shipping a new
 * silent fallback.
 *
 * REVIEWED_ADVISORY is the convergence ledger for the "Iterative Audit to Convergence"
 * standard: it shrinks as files adopt a real marker or are found to gate (and fixed).
 * A clean state is every callsite carrying a marker and this map empty — but an
 * entry here is a DELIBERATE, reasoned classification, not a TODO.
 *
 * Audit baseline: 2026-06-08, after #991 (two dangerous gates flipped fail-closed +
 * reported) and #992 (herd-aware provider-swap). The sweep over all callsites found
 * NO remaining dangerous fail-open gate — the 23 below are advisory or fail in a
 * benign direction (verified per-file). See the PR for the full audit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');

// An LLM callsite: `.evaluate(` on an IntelligenceProvider, detected by the prompt-shaped
// first argument. Matches the codebase audit's grep exactly.
const LLM_CALL_RE = /\.evaluate\(\s*(prompt|systemPrompt|simplePrompt|classifierPrompt|userPrompt|item\.content|`)/;

// Infrastructure that IMPLEMENTS evaluate() (the router + provider adapters) — not a
// gate that could "fall back to a heuristic". They ARE the swap/circuit machinery.
const EXCLUDE_RE = /IntelligenceRouter|providers[\\/]adapters[\\/]|anthropic-interactive-pool/;

// Any one of these in a callsite file satisfies the standard:
//  - DegradationReporter — the degradation is reported (not silent)
//  - `gating: true`       — the call swaps at the router, fails closed if all down
//  - @silent-fallback-ok  — existing reviewed-intentional marker
//  - @llm-fallback-ok      — LLM-specific reviewed marker
const MARKERS = ['DegradationReporter', 'gating: true', '@silent-fallback-ok', '@llm-fallback-ok'];

// Audited callsites whose LLM judgment is ADVISORY or fails in a BENIGN direction —
// degradation here informs, it does not gate a dangerous/irreversible action.
// Each was inspected (catch return / deterministic floor) on 2026-06-08.
const REVIEWED_ADVISORY: Record<string, string> = {
  'threadline/A2ACheckInScheduler.ts': 'no catch — feeds A2A check-in scheduling; failure propagates to the router; a missed check-in is benign',
  'threadline/openConversationBrief.ts': 'no catch — generates a conversational brief; failure → no brief (advisory)',
  'threadline/WarrantsReplyGate.ts': 'fail-open returns REPLY — gates whether an A2A msg warrants a reply; benign direction (an extra reply, never a harmful action)',
  'threadline/A2ACheckInProxy.ts': 'no catch — advisory A2A check-in proxy; failure propagates to the router',
  'core/TopicIntentArcCheck.ts': 'returns {actsOn:[],contradicts:[]} — advisory intent-arc analysis, no gated action',
  'core/UnjustifiedStopGate.ts': 'fail-open allows the stop AND emits a degradation report; gates an agent self-stop in the benign direction (let it stop)',
  'core/JobReflector.ts': 'returns null/defaults — advisory post-job reflection',
  'core/TopicIntentCapture.ts': 'returns {status:"degraded"} — explicitly marks degraded; advisory intent capture',
  'core/ProjectDriftChecker.ts': 'returns empty drift — advisory project-drift signal, no gated action',
  'core/CompletionEvaluator.ts': 'fail-open returns met:false ("keep working") / stopAllowed:true — conservative; gates autonomous completion in the benign direction',
  'core/ContextualEvaluator.ts': 'routes failure through handleEvaluationError — advisory contextual evaluation',
  // core/CoherenceReviewer.ts REMOVED from REVIEWED_ADVISORY (reviewer-fail-closed-on-abstain,
  // CMT-1794): it no longer silently degrades — it now carries gating:true (the router
  // swaps before abstaining) AND tags abstains so CoherenceGate fails CLOSED on a
  // high-criticality abstain external. The "no stale entries" check below enforces this
  // removal (it now hasMarker).
  'core/TopicIntentExtractor.ts': 'returns [] — advisory topic-intent extraction',
  'memory/TopicSummarizer.ts': 'returns partial results — advisory topic summary',
  'security/LLMSanitizer.ts': 'fails SAFE — default catch returns sanitized:"" (empty, the safest result); only returns original when the caller explicitly opts in',
  'providers/uxConfirm/TaskClassifier.ts': 'returns UNCLASSIFIED_PATTERN source:"fallback" — advisory task classification, explicitly fallback-marked',
  'providers/uxConfirm/OverrideDetector.ts': 'returns NO_OVERRIDE — fail-closed direction (no override = safe default)',
  'knowledge/TreeTriage.ts': 'falls back to deterministic scoreNodes() — advisory knowledge retrieval with a deterministic floor',
  'knowledge/TreeSynthesis.ts': 'returns {synthesis:null} — advisory knowledge synthesis',
  'monitoring/PromptGate.ts': 'returns/skips on malformed output — advisory prompt observation, no gated action',
  'monitoring/InputClassifier.ts': 'conservative default is "relay" (route to human) with a deterministic destructive-op floor BEFORE the LLM — never auto-approves on failure',
  'monitoring/PresenceProxy.ts': 'returns early on cancelled/started — advisory presence heartbeat',
  'messaging/slack/SlackAdapter.ts': 'fail-open returns true/[] on advisory Slack paths — no gated action',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function llmCallsiteFiles(): string[] {
  return walk(SRC)
    .filter((f) => !EXCLUDE_RE.test(f))
    .filter((f) => LLM_CALL_RE.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
}

function hasMarker(rel: string): boolean {
  const content = readFileSync(path.join(SRC, rel), 'utf8');
  return MARKERS.some((m) => content.includes(m));
}

describe('no-silent-llm-fallback — every LLM-gating callsite is swap/fail-closed/reported or reviewed-advisory', () => {
  it('every LLM callsite carries a safety marker OR is reviewed-advisory (no new silent fallback)', () => {
    const files = llmCallsiteFiles();
    expect(files.length, 'expected to discover LLM .evaluate() callsites').toBeGreaterThan(10);
    const violations = files.filter((rel) => !hasMarker(rel) && !(rel in REVIEWED_ADVISORY));
    expect(
      violations,
      `New LLM callsite(s) with neither a safety marker (DegradationReporter / "gating: true" / ` +
        `@silent-fallback-ok / @llm-fallback-ok) nor a REVIEWED_ADVISORY entry. ` +
        `Triage each: swap (gating:true), fail-closed, report the degradation, or — if its judgment ` +
        `is genuinely advisory — add it to REVIEWED_ADVISORY with a one-line reason. ` +
        `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('REVIEWED_ADVISORY has no stale entries (each is still an un-marked LLM callsite)', () => {
    const files = new Set(llmCallsiteFiles());
    const stale: string[] = [];
    for (const rel of Object.keys(REVIEWED_ADVISORY)) {
      if (!files.has(rel)) stale.push(`${rel} (no longer an LLM callsite — remove)`);
      else if (hasMarker(rel)) stale.push(`${rel} (now carries a safety marker — remove from REVIEWED_ADVISORY)`);
    }
    expect(
      stale,
      `REVIEWED_ADVISORY (the convergence ledger) has stale entries — remove them so the ledger ` +
        `honestly reflects what still degrades silently:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
