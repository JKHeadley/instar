/**
 * parser-contract classification ratchet — the test-side enforcement of the
 * Prompt↔Parser Contract standard's classification
 * (docs/specs/prompt-parser-contract-standard.md §4).
 *
 * Guarantees, structurally:
 *   1. EVERY LLM component in COMPONENT_CATEGORY carries an EXPLICIT `contract`
 *      classification — there is NO default (same polarity rule as the sibling
 *      `untrustedInput` and `judgesClaims` axes). A new LLM callsite that forgets
 *      to classify its prompt↔parser contract story fails CI (a silent omission
 *      can never default toward the un-contracted state).
 *   2. No dangling entries (classification keys must name real components).
 *   3. The WAVE-1 seed set (the four spec-named highest-stakes parsed callsites)
 *      is pinned EXACTLY — a highest-stakes callsite can never silently slip out
 *      of scope, and it may only GRADUATE to a named contract test (which removes
 *      it from the pending set), never be re-labelled away.
 *   4. The pending set (wave-1 ∪ wave-2) is pinned SHRINK-ONLY: you may graduate
 *      an entry to `{ contractTest }` (a shrink) but cannot ADD a pending entry
 *      without editing this pinned baseline — a visible, reviewed act.
 *   5. The argued-FALSE set is pinned SHRINK-ONLY and each false argues a real
 *      reason (>= 40 chars — a lazy "n/a" is refused), exactly like the
 *      bench-coverage exemptions.
 *   6. CROSS-CHECK: any gate/sentinel-category callsite marked `false` must be on
 *      the reviewed allowlist. A NEW false in a gate/sentinel category (the
 *      categories most likely to parse a closed verdict vocabulary) fails until
 *      it is added to the pinned allowlist — a visible, reviewed act (spec §4).
 *
 * Ships DARK/report-only: it wires no runtime gate; it is a pinned-baseline
 * ratchet in the same family as llm-bench-coverage-ratchet and the sibling
 * untrusted-input / judges-claims classification ratchets.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  LLM_PARSER_CONTRACT,
  type ParserContractFlag,
} from '../../src/data/llmBenchCoverage.js';

function isArguedFalse(v: ParserContractFlag): v is { false: string } {
  return typeof v === 'object' && v !== null && 'false' in v;
}
function isPending(v: ParserContractFlag): v is { pending: 'contract-wave-1' | 'contract-wave-2' } {
  return typeof v === 'object' && v !== null && 'pending' in v;
}

// ── Pinned WAVE-1 seed (spec §0/§1): the four highest-stakes parsed callsites.
// A wave-1 entry may only GRADUATE to a named contract test (removing it from
// this pending list); it can never be re-labelled `false` or dropped silently. ──
const WAVE1_SEED = [
  'MessagingToneGate',
  'ExternalOperationGate',
  'CompletionEvaluator',
  'InputClassifier',
].sort();

// ── Pinned PENDING baseline (2026-07-02). SHRINK-ONLY: graduating an entry to
// `{ contractTest }` removes it here; ADDING a pending entry means a new parsed
// callsite — argue it in src/data/llmBenchCoverage.ts AND add it here (a visible,
// reviewed act). ──
const PENDING_BASELINE = [
  // wave-1
  'MessagingToneGate',
  'ExternalOperationGate',
  'CompletionEvaluator',
  'InputClassifier',
  // wave-2
  'ProfileIntentClassifier',
  'MessageSentinel',
  'ExternalHogClassifier',
  'LLMSanitizer',
  'WarrantsReplyGate',
  'MoveIntentClassifier', // parses a closed move-intent verdict (isCommand + intent/target enums + confidence); 2026-07-04
  'HubIntentClassifier', // parses a closed hub-intent verdict (intent open/tie/null + targetTopicId enum + confidence); 2026-07-04

  'InputGuard',
  'StallTriageNurse',
  'CommitmentSentinel',
  'PresenceProxy',
  'ProjectDriftChecker',
  'TemporalCoherenceChecker',
  'SessionWatchdog',
  'ResumeQueueDrainer',
  'TopicIntentArcCheck',
  'TelegramAdapter',
  'SlackAdapter',
  'PromptGate',
  'UnjustifiedStopGate',
  'OverrideDetector',
  'TaskClassifier',
  'ResumeValidator',
  'CoherenceReviewer',
].sort();

// ── Pinned argued-FALSE baseline (2026-07-02). SHRINK-ONLY: flipping a false to
// a pending/contract entry removes it here; ADDING a name means you are declaring
// a component has NO closed-vocabulary verdict parse — argue the reason in
// src/data/llmBenchCoverage.ts AND add it here (a visible, reviewed act). ──
const ARGUED_FALSE_BASELINE = [
  'DashboardInsightEngine',
  'InputDetector',
  'SessionActivitySentinel',
  'PromiseBeacon',
  'InteractivePoolCanaryJudge',
  'SessionSummarySentinel',
  'AutoApprover',
  'IntegrationGate',
  'CoherenceGate',
  'JobReflector',
  'crossModelReviewer',
  'SelfKnowledgeTree',
  'TreeTriage',
  'TopicSummarizer',
  'ContextualEvaluator',
  'RelationshipManager',
  'StandardsConformanceReviewer',
  'DiscoveryEvaluator',
  'Usher',
  'TopicIntentExtractor',
  'PreCompactionFlush',
  'TreeSynthesis',
  'LLMConflictResolver',
  'openConversationBrief',
  'a2a-checkin',
  'correction-learning',
  'mentor-stage-b',
  'PipeSessionSpawner',
  'CartographerSweep',
  'StandardsCoverageEnrichment',
].sort();

// ── Pinned REVIEWED-false gate/sentinel allowlist. A gate or sentinel marked
// `false` is the highest-risk classification (these categories most often parse
// a closed verdict vocabulary), so each must be explicitly reviewed onto this
// list. A new gate/sentinel false NOT here fails the cross-check until reviewed. ──
const REVIEWED_FALSE_PARSER_GATE = [
  'InputDetector', // sentinel — attribution alias, live matcher is PromptGate
  'SessionActivitySentinel', // sentinel — free-text activity digest
  'PromiseBeacon', // sentinel — no live LLM prompt
  'InteractivePoolCanaryJudge', // sentinel — fixed canary constant
  'SessionSummarySentinel', // sentinel — open-set free-text fields, no closed vocabulary
  'AutoApprover', // gate — no LLM prompt of its own
  'IntegrationGate', // gate — delegates, no own callsite
  'CoherenceGate', // gate — flows through CoherenceReviewer
].sort();

describe('parser-contract classification ratchet', () => {
  it('every COMPONENT_CATEGORY key has an EXPLICIT contract classification (no default)', () => {
    const missing = Object.keys(COMPONENT_CATEGORY).filter((k) => !(k in LLM_PARSER_CONTRACT));
    expect(
      missing,
      `LLM component(s) with no contract classification: ${missing.join(', ')}.\n` +
        'Add each to LLM_PARSER_CONTRACT in src/data/llmBenchCoverage.ts as ' +
        '`{ pending: "contract-wave-2" }` (its output is machine-parsed into a closed verdict ' +
        'vocabulary — ALSO add it to PENDING_BASELINE in this test) or ' +
        '`{ false: "<argued reason>" }` (no closed-vocabulary parse — ALSO add it to ' +
        'ARGUED_FALSE_BASELINE). prompt-parser-contract-standard.md §4.',
    ).toEqual([]);
  });

  it('no dangling classification entries (keys must exist in COMPONENT_CATEGORY)', () => {
    const dangling = Object.keys(LLM_PARSER_CONTRACT).filter((k) => !(k in COMPONENT_CATEGORY));
    expect(dangling, `classification entries for unknown components: ${dangling.join(', ')}`).toEqual(
      [],
    );
  });

  it('the WAVE-1 seed set is pinned as contract-wave-1 exactly (highest-stakes cannot slip scope)', () => {
    const actualWave1 = Object.entries(LLM_PARSER_CONTRACT)
      .filter(([, v]) => isPending(v) && (v as { pending: string }).pending === 'contract-wave-1')
      .map(([k]) => k)
      .sort();
    expect(
      actualWave1,
      'The wave-1 seed (the four spec-named highest-stakes parsed callsites) drifted. A wave-1 ' +
        'callsite may only GRADUATE to a named { contractTest } (removing it here); it can never ' +
        'be re-labelled or dropped. prompt-parser-contract-standard.md §0/§1.',
    ).toEqual(WAVE1_SEED);
  });

  it('the pending set matches the pinned shrink-only baseline exactly', () => {
    const actualPending = Object.entries(LLM_PARSER_CONTRACT)
      .filter(([, v]) => isPending(v))
      .map(([k]) => k)
      .sort();
    expect(
      actualPending,
      'The pending set drifted from the pinned baseline. Graduating a pending→{ contractTest } is ' +
        'a shrink (remove it from PENDING_BASELINE); adding a new pending entry requires editing ' +
        'this pinned baseline — a visible, reviewed act.',
    ).toEqual(PENDING_BASELINE);
  });

  it('the argued-FALSE set matches the pinned shrink-only baseline exactly', () => {
    const actualFalse = Object.entries(LLM_PARSER_CONTRACT)
      .filter(([, v]) => isArguedFalse(v))
      .map(([k]) => k)
      .sort();
    expect(
      actualFalse,
      'The argued-false set drifted from the pinned baseline. Flipping a false→pending/contract is ' +
        'a shrink (remove it from ARGUED_FALSE_BASELINE); adding a new false requires editing this ' +
        'pinned baseline — a visible, reviewed act.',
    ).toEqual(ARGUED_FALSE_BASELINE);
  });

  it('every argued-false carries a real reason (>= 40 chars)', () => {
    const lazy = Object.entries(LLM_PARSER_CONTRACT)
      .filter(([, v]) => isArguedFalse(v))
      .filter(([, v]) => (v as { false: string }).false.trim().length < 40)
      .map(([k]) => k);
    expect(lazy, `argued-false entries with a too-short reason: ${lazy.join(', ')}`).toEqual([]);
  });

  it('every pending entry names a valid wave', () => {
    const bad = Object.entries(LLM_PARSER_CONTRACT)
      .filter(([, v]) => isPending(v))
      .filter(([, v]) => {
        const w = (v as { pending: string }).pending;
        return w !== 'contract-wave-1' && w !== 'contract-wave-2';
      })
      .map(([k]) => k);
    expect(bad, `pending entries with an invalid wave: ${bad.join(', ')}`).toEqual([]);
  });

  it('cross-check: every gate/sentinel marked false is on the reviewed allowlist', () => {
    const unreviewed = Object.entries(LLM_PARSER_CONTRACT)
      .filter(([, v]) => isArguedFalse(v))
      .map(([k]) => k)
      .filter((k) => COMPONENT_CATEGORY[k] === 'sentinel' || COMPONENT_CATEGORY[k] === 'gate')
      .filter((k) => !REVIEWED_FALSE_PARSER_GATE.includes(k));
    expect(
      unreviewed,
      `gate/sentinel component(s) marked contract:false without review: ${unreviewed.join(', ')}.\n` +
        'A gate or sentinel that does NOT parse a closed verdict vocabulary is the highest-risk ' +
        'classification. Add it to REVIEWED_FALSE_PARSER_GATE in this test after confirming it ' +
        'genuinely has no live callsite parsing a taught output vocabulary.',
    ).toEqual([]);
  });

  it('the reviewed allowlist has no stale entries (allowlisted names are actually false gates/sentinels)', () => {
    const stale = REVIEWED_FALSE_PARSER_GATE.filter((k) => {
      const v = LLM_PARSER_CONTRACT[k];
      const cat = COMPONENT_CATEGORY[k];
      return !(v && isArguedFalse(v) && (cat === 'sentinel' || cat === 'gate'));
    });
    expect(stale, `stale reviewed-allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });
});
