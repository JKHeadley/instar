/**
 * PROVENANCE_COVERAGE census ratchet — LLM-Decision Quality Meter G5
 * (docs/specs/llm-decision-quality-meter.md §5.6 census + §5.4.2 rule registry;
 * §Testing "Ratchet fixtures"). Precedent: tests/unit/llm-bench-coverage-ratchet.test.ts.
 *
 * Guarantees, structurally (the CI/static half — the runtime half, census-debt
 * + pending-ref-dead + wired-but-silent + exempt-but-active, lives on
 * GET /decision-quality where the evolution queue exists):
 *   1. EVERY LLM component in COMPONENT_CATEGORY declares its provenance
 *      posture, per decision point — declare-or-fail with instructions.
 *   2. Component enrollment keys are UNIQUE across ALL census entries
 *      regardless of status (ADV r7 — uniform uniqueness closes the
 *      pending-absorbs-wired-activity and exempt-false-flag carve-outs).
 *   3. PENDING + EXEMPT baselines are pinned SHRINK-ONLY, by IDENTITY
 *      (decisionPoint::component::ref) — re-pointing an entry to a different
 *      ACT, or re-classifying an exemption, is a reviewed baseline change.
 *   4. pending refs are format-valid (^ACT-\d+$); exemption taxonomy is CLOSED
 *      (free text refused); pending/exempt reasons argue >= 40 chars.
 *   5. More than the seeded first-customer enrollment requires the grading
 *      pass's per-point sub-budget FIRST (LES r6 — the trigger is structural).
 *   6. The rule registry's enums are pinned; existing ruleIds are IMMUTABLE
 *      (a predicate/parameter change mints -v2, never mutates -v1 — §5.4.5);
 *      the llm-interpreter rung stays structurally DORMANT (FD11).
 *   7. Wired entries are statically verified: the census exports a typed
 *      DP_* constant per wired point and the enrolling source imports it
 *      (string-literal-only enrollment fails).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  PROVENANCE_COVERAGE,
  RULE_REGISTRY,
  SUBBUDGET_IMPLEMENTED,
  EVIDENCE_RUNGS,
  EVIDENCE_STRENGTHS,
  DP_EXTERNAL_HOG_KILL_LEAVE,
  DP_COMPLETION_EVALUATE,
  DP_COMPLETION_STOP_RATIONALE,
  DP_MESSAGING_TONE_GATE,
  getCensusEntry,
  isEnrolled,
  getVolumeClass,
  getRule,
} from '../../src/data/provenanceCoverage.js';
// eslint-disable-next-line import/no-relative-packages
import { stripComments, isOutOfScope } from '../../scripts/lint-llm-attribution.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CENSUS_REL = 'src/data/provenanceCoverage.ts';

function walkSrc(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

const baseOf = (component: string): string => component.split('/')[0].replace(/^server:/, '').trim();

// ── Pinned baselines (2026-07-11, the census seed). SHRINK-ONLY: wiring an
// entry removes it here; ADDING a line means you are shipping a new LLM
// decision point without provenance — enroll it instead (§5.1.4 contract), or
// argue a closed-taxonomy exemption. Identity is pinned, not just count:
// re-pointing a pending entry to a different ACT changes the line = reviewed. ──

const PENDING_BASELINE = [
  // decisionPoint::component::ACT-ref
  'a2a-checkin-summarize::a2a-checkin::ACT-1193',
  'cartographer-summary-author::CartographerSweep::ACT-1193',
  'coherence-review::CoherenceReviewer::ACT-1193',
  'commitment-detect::CommitmentSentinel::ACT-1193',
  'contextual-evaluate::ContextualEvaluator::ACT-1193',
  'correction-distill::correction-learning::ACT-1193',
  'cross-model-review::crossModelReviewer::ACT-1193',
  'dashboard-insight::DashboardInsightEngine::ACT-1193',
  'discovery-evaluate::DiscoveryEvaluator::ACT-1193',
  'external-operation-gate::ExternalOperationGate::ACT-1193',
  'hub-intent-classify::HubIntentClassifier::ACT-1193',
  'input-classify::InputClassifier::ACT-1193',
  'input-guard::InputGuard::ACT-1193',
  'job-reflect::JobReflector::ACT-1193',
  'llm-conflict-resolve::LLMConflictResolver::ACT-1193',
  'llm-sanitize::LLMSanitizer::ACT-1193',
  'mentor-stage-b-classify::mentor-stage-b::ACT-1193',
  'message-sentinel-classify::MessageSentinel::ACT-1193',
  'move-intent-classify::MoveIntentClassifier::ACT-1193',
  'open-conversation-brief::openConversationBrief::ACT-1193',
  'override-detect::OverrideDetector::ACT-1193',
  'pipe-session-spawn::PipeSessionSpawner::ACT-1193',
  'pre-compaction-flush::PreCompactionFlush::ACT-1193',
  'presence-stall-judge::PresenceProxy::ACT-1193',
  'profile-intent-classify::ProfileIntentClassifier::ACT-1193',
  'project-drift-check::ProjectDriftChecker::ACT-1193',
  'prompt-injection-detect::PromptGate::ACT-1193',
  'relationship-extract::RelationshipManager::ACT-1193',
  'resume-sanity-check::ResumeQueueDrainer::ACT-1193',
  'resume-uuid-validate::ResumeValidator::ACT-1193',
  'self-knowledge-extract::SelfKnowledgeTree::ACT-1193',
  'session-activity-digest::SessionActivitySentinel::ACT-1193',
  'session-summary-extract::SessionSummarySentinel::ACT-1193',
  'slack-stall-confirm::SlackAdapter::ACT-1193',
  'stall-triage-diagnosis::StallTriageNurse::ACT-1193',
  'standards-conformance-review::StandardsConformanceReviewer::ACT-1193',
  'standards-coverage-enrich::StandardsCoverageEnrichment::ACT-1193',
  'task-classify::TaskClassifier::ACT-1193',
  'telegram-stall-confirm::TelegramAdapter::ACT-1193',
  'temporal-coherence-check::TemporalCoherenceChecker::ACT-1193',
  'topic-intent-arc-check::TopicIntentArcCheck::ACT-1193',
  'topic-intent-extract::TopicIntentExtractor::ACT-1193',
  'topic-summarize::TopicSummarizer::ACT-1193',
  'tree-synthesize::TreeSynthesis::ACT-1193',
  'tree-triage::TreeTriage::ACT-1193',
  'unjustified-stop-gate::UnjustifiedStopGate::ACT-1193',
  'usher-topic-route::Usher::ACT-1193',
  'warrants-reply-gate::WarrantsReplyGate::ACT-1193',
  'watchdog-stuck-judge::SessionWatchdog::ACT-1193',
].sort();

const EXEMPT_BASELINE = [
  // decisionPoint::component::taxonomy — each argues a real reason in the census.
  'auto-approve-injection::AutoApprover::deterministic-only',
  'coherence-gate-delegate::CoherenceGate::deterministic-only',
  'input-detector-alias::InputDetector::deterministic-only',
  'integration-gate-delegate::IntegrationGate::deterministic-only',
  'interactive-pool-canary-judge::InteractivePoolCanaryJudge::no-decision-content',
  'promise-beacon-status-line::PromiseBeacon::deterministic-only',
].sort();

// The seeded first customers (spec §5.3/G2). Enrolling ANY wired decision point
// beyond this set — including a third point inside an existing customer —
// requires SUBBUDGET_IMPLEMENTED (the §5.5 per-point round-robin sub-budget)
// to be true FIRST (LES r6: the third enroller's build fails until it exists).
const FIRST_CUSTOMER_WIRED = [
  DP_EXTERNAL_HOG_KILL_LEAVE,
  DP_COMPLETION_EVALUATE,
  DP_COMPLETION_STOP_RATIONALE,
].sort();

// Wired points whose enrolling callsite has NOT landed yet (build phases P7/P8
// wire them after this census seeds). SHRINK-ONLY: when the enrolling source
// imports the DP_* constant, REMOVE the point here (the stale check below
// forces it) — never add a wired point to this list to dodge the typed-import
// verification.
const WIRED_AWAITING_ENROLLMENT: string[] = [].sort();

// Rule identity pin (§5.4.5 — ids are IMMUTABLE and versioned; a predicate or
// parameter change mints '-v2', never mutates '-v1'). Changing any line here
// without minting a new version is exactly the mutation the pin refuses.
const RULE_BASELINE = [
  // ruleId::rung::strength::owner::windowMs
  'completion-enacted-disposition-v1::self-report::self-report::CompletionChokepoint::-',
  'completion-realcheck-v1::deterministic-ground-truth::deterministic-proof::AutonomousRealCheck::-',
  'hog-enacted-disposition-v1::self-report::self-report::ExternalHogSentinel::-',
  'hog-leave-recurrence-v1::recurrence::recurrence-proxy::ExternalHogSentinel::21600000',
  'hog-respawn-wrong-v1::deterministic-ground-truth::deterministic-proof::ExternalHogSentinel::21600000',
  'hog-sustained-right-v1::deterministic-ground-truth::negative-evidence::DecisionGrading::21600000',
].sort();

const wiredEntries = PROVENANCE_COVERAGE.filter((e) => e.status === 'wired');
const pendingEntries = PROVENANCE_COVERAGE.filter((e) => e.status.startsWith('pending:'));
const exemptEntries = PROVENANCE_COVERAGE.filter((e) => e.status.startsWith('exempt:'));

describe('provenance-coverage census ratchet (declare-or-fail)', () => {
  it('every COMPONENT_CATEGORY key has a census declaration (a new LLM decision point must declare its provenance posture)', () => {
    const declared = new Set(PROVENANCE_COVERAGE.map((e) => baseOf(e.component)));
    const missing = Object.keys(COMPONENT_CATEGORY).filter((k) => !declared.has(k));
    expect(
      missing,
      `LLM component(s) without a provenance-census declaration: ${missing.join(', ')}.\n` +
        'Add each decision point to src/data/provenanceCoverage.ts as status wired ' +
        '(enroll via the §5.1.4 options.provenance contract, importing the DP_* id), ' +
        "pending:<ACT-ref> (ALSO add it to PENDING_BASELINE in this test — a visible act), " +
        'or exempt:<closed-taxonomy> with a real argument (ALSO pinned here). ' +
        'llm-decision-quality-meter spec §5.6.',
    ).toEqual([]);
  });

  it('no dangling census components (every entry base-component exists in COMPONENT_CATEGORY)', () => {
    const dangling = PROVENANCE_COVERAGE
      .filter((e) => !(baseOf(e.component) in COMPONENT_CATEGORY))
      .map((e) => `${e.decisionPoint} → '${e.component}'`);
    expect(dangling, `census entries for unknown components: ${dangling.join(', ')}`).toEqual([]);
  });

  it('component enrollment keys are UNIQUE across ALL census entries regardless of status (ADV r7 uniform 1:1 convention)', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const e of PROVENANCE_COVERAGE) {
      const prior = seen.get(e.component);
      if (prior) dups.push(`'${e.component}' shared by ${prior} and ${e.decisionPoint}`);
      else seen.set(e.component, e.decisionPoint);
    }
    expect(
      dups,
      `Component key sharing detected (a second judgment inside a declared component needs its OWN ` +
        `suffixed key, e.g. 'CompletionEvaluator/P13'; linkage via composition only — §5.1.1): ${dups.join('; ')}`,
    ).toEqual([]);
  });

  it('decision-point ids are unique and charset-clamped (^[a-z0-9][a-z0-9-]{0,63}$)', () => {
    const seen = new Set<string>();
    for (const e of PROVENANCE_COVERAGE) {
      expect(seen.has(e.decisionPoint), `duplicate decisionPoint id '${e.decisionPoint}'`).toBe(false);
      seen.add(e.decisionPoint);
      expect(e.decisionPoint, `decisionPoint id '${e.decisionPoint}' violates the id charset`).toMatch(
        /^[a-z0-9][a-z0-9-]{0,63}$/,
      );
    }
  });

  it('entry shapes are valid (contentClass enum; wired ⇒ volumeClass; volume/composition formats)', () => {
    for (const e of PROVENANCE_COVERAGE) {
      expect(['metadata', 'content-bearing'], `${e.decisionPoint}: contentClass`).toContain(e.contentClass);
      if (e.status === 'wired') {
        expect(e.volumeClass, `${e.decisionPoint}: a wired entry MUST declare its volumeClass (§5.6 volume valve)`).toBeDefined();
      }
      if (e.volumeClass !== undefined) {
        expect(
          e.volumeClass,
          `${e.decisionPoint}: volumeClass must be 'full' | 'sampled:<0<rate<=1>' | 'budget:<rows/day>'`,
        ).toMatch(/^(full|sampled:(0\.\d+|1(\.0+)?)|budget:[1-9]\d*)$/);
      }
      if (e.composition !== undefined && e.composition !== 'single') {
        expect(e.composition, `${e.decisionPoint}: composition format`).toMatch(/^multi-call:.+$/);
        const linked = e.composition.slice('multi-call:'.length).split(',').map((s) => s.trim());
        for (const id of linked) {
          expect(id === e.decisionPoint, `${e.decisionPoint}: composition may not link itself`).toBe(false);
          expect(getCensusEntry(id), `${e.decisionPoint}: composition links unknown decision point '${id}'`).toBeDefined();
        }
      }
    }
  });
});

describe('pending — the two-layer check, CI static half (§5.6)', () => {
  it('pending refs are format-valid (^ACT-\\d+$) and every pending entry argues a real reason (>= 40 chars)', () => {
    for (const e of pendingEntries) {
      const ref = e.status.slice('pending:'.length);
      expect(ref, `${e.decisionPoint}: pending ref '${ref}' must be a bare evolution-queue id (ACT-<n>)`).toMatch(/^ACT-\d+$/);
      expect(
        (e.reason ?? '').length,
        `${e.decisionPoint}: pending reason must be a real argument (>= 40 chars)`,
      ).toBeGreaterThanOrEqual(40);
    }
  });

  it('the pending set is pinned SHRINK-ONLY, by identity (count only goes down; re-pointing an ACT changes the line = reviewed)', () => {
    const current = pendingEntries
      .map((e) => `${e.decisionPoint}::${e.component}::${e.status.slice('pending:'.length)}`)
      .sort();
    const added = current.filter((line) => !PENDING_BASELINE.includes(line));
    expect(
      added,
      `NEW/CHANGED pending census entries (enroll the point via §5.1.4 instead, or make the baseline ` +
        `change visible here): ${added.join(', ')}`,
    ).toEqual([]);
  });
});

describe('exempt — closed taxonomy, pinned shrink-only (§5.6)', () => {
  it('free-text exemptions are refused (closed taxonomy: deterministic-only | no-decision-content | operator-ratified:<ref>)', () => {
    for (const e of exemptEntries) {
      expect(
        e.status,
        `${e.decisionPoint}: '${e.status}' is not a closed-taxonomy exemption (an exemption is a classification, not an essay)`,
      ).toMatch(/^exempt:(deterministic-only|no-decision-content|operator-ratified:.{8,})$/);
    }
  });

  it('every exemption argues a real reason (>= 40 chars)', () => {
    for (const e of exemptEntries) {
      expect(
        (e.reason ?? '').length,
        `${e.decisionPoint}: exemption reason must be a real argument (>= 40 chars)`,
      ).toBeGreaterThanOrEqual(40);
    }
  });

  it('the exempt set is pinned SHRINK-ONLY, by identity (adding or RE-CLASSIFYING an exemption is a reviewed baseline change)', () => {
    const current = exemptEntries
      .map((e) => `${e.decisionPoint}::${e.component}::${e.status.slice('exempt:'.length)}`)
      .sort();
    const added = current.filter((line) => !EXEMPT_BASELINE.includes(line));
    expect(
      added,
      `NEW/CHANGED exemptions (must be argued AND pinned here — 'no-decision-content' is deliberately ` +
        `outside exempt-but-active, so review is its only guard): ${added.join(', ')}`,
    ).toEqual([]);
  });
});

describe('enrollment growth — the sub-budget trigger is structural (LES r6, §5.5)', () => {
  it('enrolling beyond two customers requires the grading-pass per-point sub-budget', () => {
    const customers = new Set(wiredEntries.map((e) => baseOf(e.component)));
    expect(
      customers.size <= 2 || SUBBUDGET_IMPLEMENTED,
      `${customers.size} enrolled customers (${[...customers].join(', ')}) but the grading pass's ` +
        'GLOBAL maxDecisionsPerPass bound has no per-point sub-budget — a high-volume point could ' +
        'starve sibling evidence windows. Implement the round-robin-over-cursors sub-budget (§5.5) ' +
        'and flip SUBBUDGET_IMPLEMENTED in src/data/provenanceCoverage.ts BEFORE enrolling a third customer.',
    ).toBe(true);
  });

  it('enrolling any wired point beyond the seeded first-customer set requires the sub-budget', () => {
    const beyondSeed = wiredEntries
      .map((e) => e.decisionPoint)
      .filter((dp) => !FIRST_CUSTOMER_WIRED.includes(dp));
    expect(
      beyondSeed.length === 0 || SUBBUDGET_IMPLEMENTED,
      `Wired decision point(s) beyond the spec §5.3 seed (${beyondSeed.join(', ')}) require the ` +
        'grading-pass per-point sub-budget first (flip SUBBUDGET_IMPLEMENTED only in the PR that builds it).',
    ).toBe(true);
  });

  it('the seeded first customers stay wired at volumeClass full (regression pin — G2 may never slide back to pending)', () => {
    for (const dp of FIRST_CUSTOMER_WIRED) {
      const e = getCensusEntry(dp);
      expect(e?.status, `${dp} must stay wired`).toBe('wired');
      expect(e?.volumeClass, `${dp} is a low-frequency high-stakes first customer — full-class by spec §5.3`).toBe('full');
      expect(e?.contentClass, `${dp} judges process/transcript content — content-bearing by spec §5.3`).toBe('content-bearing');
    }
  });
});

describe('messaging-tone-gate — the third enrolled customer (§5.6 high-volume valve)', () => {
  it('is WIRED (a regression to pending fails here — the ratchet now REQUIRES it enrolled)', () => {
    const e = getCensusEntry(DP_MESSAGING_TONE_GATE);
    expect(e, 'messaging-tone-gate must be a census entry').toBeDefined();
    expect(e?.status, 'messaging-tone-gate must be WIRED (not pending) — the pending→wired flip must not regress').toBe('wired');
    expect(isEnrolled(DP_MESSAGING_TONE_GATE)).toBe(true);
    // A regression to pending would ALSO reintroduce the PENDING_BASELINE line —
    // the shrink-only pending pin (above) would then fail on the new/changed line.
  });

  it('declares a HIGH-VOLUME valve — a per-day budget, NEVER full (§5.6 always-on gate)', () => {
    const vc = getVolumeClass(DP_MESSAGING_TONE_GATE);
    expect(vc, 'messaging-tone-gate MUST declare its volumeClass').toBeDefined();
    expect(vc, 'an always-on high-volume gate MUST NOT be full — sampled:<rate> or budget:<rows/day> only (§5.6)').not.toBe('full');
    expect(vc, 'the chosen valve is a per-UTC-day COUNT budget').toMatch(/^budget:[1-9]\d*$/);
  });

  it('is content-bearing (it judges an agent-authored outbound message → identity-only content)', () => {
    expect(getCensusEntry(DP_MESSAGING_TONE_GATE)?.contentClass).toBe('content-bearing');
  });

  it('enrolling it REQUIRED the sub-budget (SUBBUDGET_IMPLEMENTED true — the structural trigger it tripped)', () => {
    // The two enrollment-growth guards above only pass because the sub-budget
    // now exists; pin the flag so a revert of the sub-budget re-fails here too.
    expect(SUBBUDGET_IMPLEMENTED, 'the tone-gate enrollment requires the §5.5 per-point sub-budget in place').toBe(true);
  });
});

describe('rule registry (§5.4.2) — enums pinned, identities immutable, dormant rung refused', () => {
  it('every rule row is well-formed (key = ruleId; closed enums; non-empty owner; versioned id)', () => {
    for (const [key, rule] of Object.entries(RULE_REGISTRY)) {
      expect(rule.ruleId, `registry key '${key}' must equal its ruleId`).toBe(key);
      expect(EVIDENCE_RUNGS, `${key}: rung`).toContain(rule.rung);
      expect(EVIDENCE_STRENGTHS, `${key}: evidenceStrength`).toContain(rule.evidenceStrength);
      expect(rule.owningComponent.trim().length, `${key}: owningComponent must name the annotator actor`).toBeGreaterThan(0);
      expect(key, `${key}: ruleId must be versioned (…-v<n>) — a predicate/parameter change mints a new version`).toMatch(
        /^[a-z0-9][a-z0-9-]*-v\d+$/,
      );
      if (rule.windowMs !== undefined) {
        expect(Number.isFinite(rule.windowMs) && rule.windowMs > 0, `${key}: windowMs must be a positive number`).toBe(true);
      }
    }
  });

  it('the llm-interpreter rung is structurally DORMANT this build (FD11 — no rule may register it until ACT-1198 lands)', () => {
    const offenders = Object.values(RULE_REGISTRY).filter((r) => r.rung === 'llm-interpreter').map((r) => r.ruleId);
    expect(
      offenders,
      'The LLM evidence-interpreter rung activates only behind ACT-1198 (benched evaluator + FENCE + ' +
        `injection-exposed registration): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('registered rule identities are IMMUTABLE (baseline pin — mutate = mint a new -v<n+1> instead)', () => {
    const current = Object.values(RULE_REGISTRY)
      .map((r) => `${r.ruleId}::${r.rung}::${r.evidenceStrength}::${r.owningComponent}::${r.windowMs ?? '-'}`)
      .sort();
    // Every baseline rule must still exist, byte-identical (immutability); new
    // rule VERSIONS may be added (they extend `current` without touching these).
    for (const pinned of RULE_BASELINE) {
      expect(current, `pinned rule identity missing or mutated: ${pinned}`).toContain(pinned);
    }
    // And every pinned ruleId resolves via the lookup the chokepoint uses.
    for (const pinned of RULE_BASELINE) {
      const id = pinned.split('::')[0];
      expect(getRule(id)?.ruleId).toBe(id);
    }
  });

  it('the enums themselves are pinned (INT r3 — the ratchet fixtures pin the registry enums)', () => {
    expect([...EVIDENCE_RUNGS]).toEqual([
      'deterministic-ground-truth',
      'recurrence',
      'llm-interpreter',
      'self-report',
    ]);
    expect([...EVIDENCE_STRENGTHS]).toEqual([
      'deterministic-proof',
      'negative-evidence',
      'recurrence-proxy',
      'self-report',
    ]);
  });
});

describe('lookup helpers (the contracts later phases import)', () => {
  it('getCensusEntry / isEnrolled / getVolumeClass answer both sides of the boundary', () => {
    expect(getCensusEntry(DP_EXTERNAL_HOG_KILL_LEAVE)?.component).toBe('ExternalHogClassifier');
    expect(isEnrolled(DP_COMPLETION_EVALUATE)).toBe(true);
    expect(getVolumeClass(DP_COMPLETION_STOP_RATIONALE)).toBe('full');
    // A pending point is declared but NOT enrolled — the seam writes nothing,
    // and a forward-declared volume class must not valve anything.
    expect(getCensusEntry('coherence-review')?.status).toBe('pending:ACT-1193');
    expect(isEnrolled('coherence-review')).toBe(false);
    expect(getVolumeClass('coherence-review')).toBeUndefined();
    // Unknown decision points: undefined/false, never a throw (the settlement
    // write counts unknowns — §5.6).
    expect(getCensusEntry('never-declared-point')).toBeUndefined();
    expect(isEnrolled('never-declared-point')).toBe(false);
    expect(getVolumeClass('never-declared-point')).toBeUndefined();
    expect(getRule('not-a-rule-v1')).toBeUndefined();
  });
});

describe('wired verification — static half (§5.6: typed registration, not trusted declaration)', () => {
  const censusSource = fs.readFileSync(path.join(ROOT, CENSUS_REL), 'utf-8');
  const constNameFor = (dp: string): string => `DP_${dp.toUpperCase().replace(/-/g, '_')}`;

  it('every wired decision point exports a typed DP_* id constant from the census module (naming convention)', () => {
    for (const e of wiredEntries) {
      const constName = constNameFor(e.decisionPoint);
      expect(
        censusSource.includes(`export const ${constName} = '${e.decisionPoint}'`),
        `${e.decisionPoint}: the census must export \`export const ${constName} = '${e.decisionPoint}'\` ` +
          '(enrolling callsites import the constant — typed registration)',
      ).toBe(true);
    }
  });

  it('wired points not in WIRED_AWAITING_ENROLLMENT have an enrolling source importing the DP_* constant + referencing provenance enrollment', () => {
    const files = walkSrc().filter((f) => path.relative(ROOT, f) !== CENSUS_REL);
    for (const e of wiredEntries) {
      if (WIRED_AWAITING_ENROLLMENT.includes(e.decisionPoint)) continue;
      const constName = constNameFor(e.decisionPoint);
      const enrolling = files.filter((f) => {
        const text = stripComments(fs.readFileSync(f, 'utf-8'));
        return new RegExp(`\\b${constName}\\b`).test(text) && /provenance\s*:/.test(text);
      });
      expect(
        enrolling.length,
        `${e.decisionPoint} is declared wired but NO src file imports ${constName} and references ` +
          "an options.provenance enrollment — a wired declaration is verified, not trusted (§5.6). " +
          'Either wire the callsite or move the point back to pending.',
      ).toBeGreaterThan(0);
    }
  });

  it('WIRED_AWAITING_ENROLLMENT is shrink-only and not stale (an enrolled point must leave the list — the visible act)', () => {
    // Every listed point must be a wired census entry…
    for (const dp of WIRED_AWAITING_ENROLLMENT) {
      expect(getCensusEntry(dp)?.status, `${dp} in WIRED_AWAITING_ENROLLMENT is not a wired census entry`).toBe('wired');
    }
    // …and must still be genuinely un-enrolled: once the enrolling source lands
    // (build phases P7/P8), REMOVE the point from WIRED_AWAITING_ENROLLMENT so
    // the typed-import verification above starts enforcing for it.
    const files = walkSrc().filter((f) => path.relative(ROOT, f) !== CENSUS_REL);
    const stale: string[] = [];
    for (const dp of WIRED_AWAITING_ENROLLMENT) {
      const constName = constNameFor(dp);
      const referenced = files.some((f) => new RegExp(`\\b${constName}\\b`).test(stripComments(fs.readFileSync(f, 'utf-8'))));
      if (referenced) stale.push(dp);
    }
    expect(
      stale,
      `Enrolling source landed for: ${stale.join(', ')} — remove from WIRED_AWAITING_ENROLLMENT in this test ` +
        '(shrink-only; the typed-import check then enforces).',
    ).toEqual([]);
  });

  it('NEGATIVE: no string-literal decisionPoint inside an options.provenance enrollment block (typed import required)', () => {
    // "A decision point that exists only as a string literal at a callsite
    // fails the ratchet" (§5.6). Scoped to ENROLLMENT blocks (`provenance: {…}`)
    // so the two existing deterministic JPL callsites (SpawnAdmission /
    // DuplicateSessionReconciler — direct provenance(...) CALLS, not router
    // enrollment) stay out of scope by construction.
    const offenders: string[] = [];
    for (const f of walkSrc()) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (rel === CENSUS_REL || isOutOfScope(rel)) continue;
      const text = stripComments(fs.readFileSync(f, 'utf-8'));
      const re = /provenance\s*:\s*\{[\s\S]{0,300}?decisionPoint\s*:\s*(['"`])([^'"`]+)\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) offenders.push(`${rel}: '${m[2]}'`);
    }
    expect(
      offenders,
      'String-literal decisionPoint in an enrollment block — import the DP_* constant from ' +
        `src/data/provenanceCoverage.ts instead (typed registration, §5.6): ${offenders.join('; ')}`,
    ).toEqual([]);
  });
});

describe('informational — declared points vs discovered attribution callsites (codex r7: a drift hint for review, never a gate)', () => {
  it('logs per-component callsite-count vs declared-decision-point mismatches (non-blocking)', () => {
    const counts = new Map<string, number>();
    for (const f of walkSrc()) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (isOutOfScope(rel)) continue;
      const text = stripComments(fs.readFileSync(f, 'utf-8'));
      const re = /attribution[\s\S]{0,160}?component\s*:\s*(['"`])([^'"`]+)\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const base = baseOf(m[2]);
        counts.set(base, (counts.get(base) ?? 0) + 1);
      }
    }
    const declaredPoints = new Map<string, number>();
    for (const e of PROVENANCE_COVERAGE) {
      const base = baseOf(e.component);
      declaredPoints.set(base, (declaredPoints.get(base) ?? 0) + 1);
    }
    const drift: string[] = [];
    for (const [base, declared] of declaredPoints) {
      const discovered = counts.get(base) ?? 0;
      if (discovered !== declared) drift.push(`${base}: ${discovered} attribution callsite(s) vs ${declared} declared decision point(s)`);
    }
    for (const [base, discovered] of counts) {
      if (!declaredPoints.has(base)) drift.push(`${base}: ${discovered} attribution callsite(s), ZERO census declarations`);
    }
    if (drift.length > 0) {
      // Deliberately console.log, never expect(): the declared-vs-discovered
      // residual stays review-owned; this gives review a number to look at
      // (multi-callsite components and shared prompts legitimately diverge).
      // eslint-disable-next-line no-console
      console.log(
        `[provenance-census] INFORMATIONAL declared-vs-discovered drift (${drift.length} component(s)):\n  ` +
          drift.sort().join('\n  '),
      );
    }
    expect(true).toBe(true);
  });
});
