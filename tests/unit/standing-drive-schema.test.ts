// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import {
  applyDispositionTransition,
  canonicalizeEnvelope,
  checkAuthorityRebind,
  composeStopDecision,
  computeCreationKey,
  computeEnvelopeDigest,
  computeSemanticFingerprint,
  deriveActionDecision,
  deriveActionDecisionDetailed,
  isStandingDriveAlive,
  readBreakerEligibility,
  validateStandingDriveExtensionV1,
  type StandingDriveExtensionV1,
  type StandingDriveSource,
} from '../../src/core/StandingDriveSchema.js';

const h = (c: string) => c.repeat(64);
const now = '2026-07-18T00:00:00.000Z';

function extension(topicId = '458', source: StandingDriveSource = 'telegram'): StandingDriveExtensionV1 {
  const authority = {
    source,
    verifiedEventId: 'event-7',
    operatorPrincipalHash: h('a'),
    topicBindingDigest: h('b'),
    projectBindingDigest: h('c'),
    authorizedAt: now,
  } as const;
  const bare = {
    phases: [{ id: 'phase-1', domain: 'git' as const, criterionIds: ['criterion-1'], actionRuleIds: ['rule-1'] }],
    acceptanceCriteria: [{ id: 'criterion-1', kind: 'test-pass' }],
    allowedActions: [{ id: 'rule-1', domain: 'git' as const, operation: 'modify', targets: ['src/'], constraints: { branch: 'agent/test', paths: ['src/'] } }],
  };
  return {
    schemaVersion: 1,
    requestDigest: h('d'),
    creationKey: computeCreationKey(topicId, authority, h('d')),
    authority,
    envelope: { ...bare, digest: computeEnvelopeDigest(bare) },
    cursor: { phaseId: 'phase-1', state: 'active' },
    disposition: { state: 'active' },
    semanticProgress: { fingerprint: h('e'), lastProgressAt: now, version: 0 },
    breaker: { state: 'closed', consecutiveNoProgress: 0 },
    revision: 1,
  };
}

describe('StandingDriveExtensionV1 canonical schema', () => {
  it('includes enrollment source in the creation key', () => {
    expect(extension('458', 'telegram').creationKey).not.toBe(extension('458', 'local-operator').creationKey);
  });

  it('canonicalizes envelope insertion order deterministically', () => {
    const ext = extension();
    const reversed = {
      allowedActions: [...ext.envelope.allowedActions].reverse(),
      acceptanceCriteria: [...ext.envelope.acceptanceCriteria].reverse(),
      phases: [...ext.envelope.phases].reverse(),
    };
    expect(canonicalizeEnvelope(ext.envelope)).toBe(canonicalizeEnvelope(reversed));
    expect(computeEnvelopeDigest(ext.envelope)).toBe(computeEnvelopeDigest(reversed));
  });

  it('canonicalizes without locale-dependent collation', () => {
    const original = String.prototype.localeCompare;
    Object.defineProperty(String.prototype, 'localeCompare', { configurable: true, value: () => { throw new Error('locale collation used'); } });
    try {
      expect(() => computeEnvelopeDigest(extension().envelope)).not.toThrow();
      expect(() => computeSemanticFingerprint({ phaseStates: [{ id: 'z', state: 'active' }, { id: 'A', state: 'pending' }], evidenceIds: ['z', 'A'], closedDefectIds: [], blockState: 'none' })).not.toThrow();
    } finally {
      Object.defineProperty(String.prototype, 'localeCompare', { configurable: true, value: original });
    }
  });

  it('validates a complete extension and rejects tampered digests/future versions', () => {
    expect(validateStandingDriveExtensionV1(extension(), '458')).toBe(true);
    expect(validateStandingDriveExtensionV1({ ...extension(), creationKey: h('f') }, '458')).toBe(false);
    expect(validateStandingDriveExtensionV1({ ...extension(), schemaVersion: 2 })).toBe(false);
  });

  it('rejects unknown enrollment sources without re-keying existing records', () => {
    const ext = extension();
    expect(validateStandingDriveExtensionV1({ ...ext, authority: { ...ext.authority, source: 'threadline' } })).toBe(false);
  });

  it('returns false rather than throwing on malformed nested collections', () => {
    expect(() => validateStandingDriveExtensionV1({ ...extension(), envelope: { digest: h('a') } })).not.toThrow();
    expect(validateStandingDriveExtensionV1({ ...extension(), envelope: { digest: h('a') } })).toBe(false);
  });

  it('rejects duplicate ids, duplicate references, and dangling or cross-domain references', () => {
    const ext = extension();
    const redigest = (envelope: Omit<StandingDriveExtensionV1['envelope'], 'digest'>) => ({ ...envelope, digest: computeEnvelopeDigest(envelope) });
    const duplicateCriteria = { ...ext.envelope, acceptanceCriteria: [...ext.envelope.acceptanceCriteria, ext.envelope.acceptanceCriteria[0]] };
    expect(validateStandingDriveExtensionV1({ ...ext, envelope: redigest(duplicateCriteria) })).toBe(false);
    const duplicateRefs = { ...ext.envelope, phases: [{ ...ext.envelope.phases[0], criterionIds: ['criterion-1', 'criterion-1'] }] };
    expect(validateStandingDriveExtensionV1({ ...ext, envelope: redigest(duplicateRefs) })).toBe(false);
    const dangling = { ...ext.envelope, phases: [{ ...ext.envelope.phases[0], actionRuleIds: ['missing-rule'] }] };
    expect(validateStandingDriveExtensionV1({ ...ext, envelope: redigest(dangling) })).toBe(false);
    const crossDomain = { ...ext.envelope, allowedActions: [{ ...ext.envelope.allowedActions[0], domain: 'message-review' as const }] };
    expect(validateStandingDriveExtensionV1({ ...ext, envelope: redigest(crossDomain) })).toBe(false);
  });

  it('validates every optional field when present', () => {
    const ext = extension();
    expect(validateStandingDriveExtensionV1({ ...ext, commitmentRef: 'commitment-1', disposition: { state: 'superseded', at: now, reasonCode: 'replaced', supersededByRunId: 'run-2' }, breaker: { state: 'tripped', consecutiveNoProgress: 3, trippedAt: now, rearmBasis: 'operator-transition' } })).toBe(true);
    expect(validateStandingDriveExtensionV1({ ...ext, commitmentRef: 'x'.repeat(161) })).toBe(false);
    expect(validateStandingDriveExtensionV1({ ...ext, disposition: { state: 'stopped', at: 'not-a-date' } })).toBe(false);
    expect(validateStandingDriveExtensionV1({ ...ext, disposition: { state: 'stopped', at: 'July 17, 2026' } })).toBe(false);
    expect(validateStandingDriveExtensionV1({ ...ext, authority: { ...ext.authority, authorizedAt: '2026-07-18T00:00:00Z' } })).toBe(false);
    expect(validateStandingDriveExtensionV1({ ...ext, breaker: { state: 'tripped', consecutiveNoProgress: 1, rearmBasis: 'timer' } })).toBe(false);
  });
});

describe('closed deterministic action validator', () => {
  it('allows only the exact enumerated phase/action/constraints', () => {
    const ext = extension();
    expect(deriveActionDecision(ext, 'phase-1', { domain: 'git', operation: 'modify', target: 'src/', constraints: { paths: ['src/'], branch: 'agent/test' } })).toBe('allow');
    expect(deriveActionDecision(ext, 'phase-1', { domain: 'git', operation: 'modify', target: 'docs/', constraints: { paths: ['src/'], branch: 'agent/test' } })).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(ext, 'phase-1', { domain: 'git', operation: 'push', target: 'src/' })).toBe('hold:not-enumerated');
    expect(deriveActionDecision(ext, 'other', { domain: 'git', operation: 'modify', target: 'src/' })).toBe('hold:phase-mismatch');
  });

  it('fails closed for corrupt and future extensions', () => {
    expect(deriveActionDecision(null, 'phase-1', { domain: 'git', operation: 'modify', target: 'src/' })).toBe('hold:corrupt');
    expect(deriveActionDecision({ ...extension(), schemaVersion: 2 }, 'phase-1', { domain: 'git', operation: 'modify', target: 'src/' })).toBe('hold:ineligible-extension');
  });

  it('holds a plausibly related action that differs from the frozen envelope', () => {
    const decision = deriveActionDecisionDetailed(extension(), 'phase-1', {
      domain: 'git',
      operation: 'modify',
      target: 'site/src/content/docs/features/standing-drive.md',
      constraints: { paths: ['src/'], branch: 'agent/test' },
    });

    expect(decision).toMatchObject({
      decision: 'hold:constraint-mismatch',
      matchedRuleId: null,
      envelopeDigest: extension().envelope.digest,
    });
    expect(decision.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses deterministic project-relative prefix semantics without traversal escape', () => {
    const ext = extension();
    const request = { domain: 'git' as const, operation: 'modify', constraints: { paths: ['src/'], branch: 'agent/test' } };
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: 'src/core/StandingDriveSchema.ts' })).toBe('allow');
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: 'src/../docs/standing-drive.md' })).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: '/src/core/StandingDriveSchema.ts' })).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: 'src\\core\\StandingDriveSchema.ts' })).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: 'C:/Windows/system.ini' })).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: 'C:Windows/system.ini' })).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(ext, 'phase-1', { ...request, target: 'src//core/StandingDriveSchema.ts' })).toBe('hold:constraint-mismatch');
  });

  it('rejects drive-qualified requests and frozen targets even under a root rule', () => {
    const ext = extension();
    const rootRule = { ...ext.envelope.allowedActions[0], targets: ['.'] };
    const envelope = { ...ext.envelope, allowedActions: [rootRule] };
    const rooted = { ...ext, envelope: { ...envelope, digest: computeEnvelopeDigest(envelope) } };
    const badFrozenRule = { ...rootRule, targets: ['C:/'] };
    const badEnvelope = { ...ext.envelope, allowedActions: [badFrozenRule] };
    const badFrozen = { ...ext, envelope: { ...badEnvelope, digest: computeEnvelopeDigest(badEnvelope) } };
    const request = { domain: 'git' as const, operation: 'modify', target: 'C:/Windows/system.ini', constraints: { paths: ['src/'], branch: 'agent/test' } };

    expect(deriveActionDecision(rooted, 'phase-1', request)).toBe('hold:constraint-mismatch');
    expect(deriveActionDecision(badFrozen, 'phase-1', { ...request, target: 'C:/' })).toBe('hold:corrupt');
  });

  it('returns the matched frozen rule and a stable cross-machine decision digest', () => {
    const ext = extension();
    const request = { domain: 'git' as const, operation: 'modify', target: 'src/', constraints: { paths: ['src/'], branch: 'agent/test' } };
    const first = deriveActionDecisionDetailed(ext, 'phase-1', request);
    const reordered = deriveActionDecisionDetailed(ext, 'phase-1', {
      ...request,
      constraints: { branch: 'agent/test', paths: ['src/'] },
    });

    expect(first).toMatchObject({ decision: 'allow', matchedRuleId: 'rule-1', envelopeDigest: ext.envelope.digest });
    expect(reordered).toEqual(first);
    expect(deriveActionDecisionDetailed(ext, 'phase-1', { ...request, target: 'src' }).decisionDigest).toBe(first.decisionDigest);
  });

  it('chooses the same matching rule regardless of replicated array order', () => {
    const ext = extension();
    const duplicate = { ...ext.envelope.allowedActions[0], id: 'rule-0' };
    const envelope = {
      ...ext.envelope,
      phases: [{ ...ext.envelope.phases[0], actionRuleIds: ['rule-1', 'rule-0'] }],
      allowedActions: [ext.envelope.allowedActions[0], duplicate],
    };
    const redigested = { ...ext, envelope: { ...envelope, digest: computeEnvelopeDigest(envelope) } };
    const reversedEnvelope = { ...redigested.envelope, allowedActions: [...redigested.envelope.allowedActions].reverse() };
    const reversed = { ...redigested, envelope: { ...reversedEnvelope, digest: computeEnvelopeDigest(reversedEnvelope) } };
    const request = { domain: 'git' as const, operation: 'modify', target: 'src/core/StandingDriveSchema.ts', constraints: { paths: ['src/'], branch: 'agent/test' } };

    expect(deriveActionDecisionDetailed(redigested, 'phase-1', request)).toEqual(deriveActionDecisionDetailed(reversed, 'phase-1', request));
    expect(deriveActionDecisionDetailed(redigested, 'phase-1', request).matchedRuleId).toBe('rule-0');
  });

  it('fails closed without throwing for malformed runtime requests', () => {
    const malformed = [null, {}, { domain: 'git', operation: 'modify', target: 'src/', constraints: null }, {
      domain: 'git', operation: 'modify', target: 'src/', constraints: { branch: { semantic: 'close enough' } },
    }, { domain: 'git', operation: 'modify', target: 'src/', semanticHint: 'close enough' }];

    for (const request of malformed) {
      expect(() => deriveActionDecisionDetailed(extension(), 'phase-1', request)).not.toThrow();
      expect(deriveActionDecisionDetailed(extension(), 'phase-1', request).decision).toBe('hold:corrupt');
    }
  });

  it('does not consult a model, network, locale, or clock seam', () => {
    const originalFetch = globalThis.fetch;
    const originalLocaleCompare = String.prototype.localeCompare;
    const originalNow = Date.now;
    globalThis.fetch = (() => { throw new Error('network seam consulted'); }) as typeof fetch;
    Object.defineProperty(String.prototype, 'localeCompare', { configurable: true, value: () => { throw new Error('locale seam consulted'); } });
    Date.now = () => { throw new Error('clock seam consulted'); };
    try {
      expect(deriveActionDecisionDetailed(extension(), 'phase-1', {
        domain: 'git', operation: 'push', target: 'src/', constraints: { paths: ['src/'], branch: 'agent/test' },
      }).decision).toBe('hold:not-enumerated');
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(String.prototype, 'localeCompare', { configurable: true, value: originalLocaleCompare });
      Date.now = originalNow;
    }
  });
});

describe('authority, lifecycle, stop, progress, and breaker validators', () => {
  it('requires exact local authority receipt equality', () => {
    const ext = extension();
    expect(checkAuthorityRebind(ext, ext.authority)).toBe(true);
    expect(checkAuthorityRebind(ext, { ...ext.authority, operatorPrincipalHash: h('f') })).toBe(false);
  });

  it('uses nested disposition as drive-aliveness regardless of base run status', () => {
    expect(isStandingDriveAlive(extension())).toBe(true);
    const stopped = { ...extension(), disposition: { state: 'stopped' as const } };
    expect(isStandingDriveAlive(stopped)).toBe(false);
  });

  it('keeps disposition active load-bearing when the base run is expired', () => {
    const record = { status: 'expired', standingDrive: extension() };
    expect(record.status).toBe('expired');
    expect(isStandingDriveAlive(record.standingDrive)).toBe(true);
  });

  it('fails closed on unreadable/tripped breaker state', () => {
    expect(readBreakerEligibility(null)).toEqual({ eligible: false, reason: 'breaker-unreadable' });
    expect(readBreakerEligibility({ ...extension(), breaker: { state: 'tripped', consecutiveNoProgress: 3 } })).toEqual({ eligible: false, reason: 'breaker-tripped' });
  });

  it('fingerprints semantic fields only', () => {
    const input = { phaseStates: [{ id: 'p', state: 'active' }], evidenceIds: ['e'], closedDefectIds: [], blockState: 'none' };
    expect(computeSemanticFingerprint(input)).toBe(computeSemanticFingerprint({ ...input }));
    expect(computeSemanticFingerprint(input)).not.toBe(computeSemanticFingerprint({ ...input, blockState: 'user-input' }));
  });

  it('allows resumable stop but refuses terminal resurrection', () => {
    const stopped = applyDispositionTransition(extension(), 'stopped', true, now);
    expect(stopped.revision).toBe(2);
    expect(applyDispositionTransition(stopped, 'active', true, now).disposition.state).toBe('active');
    const abandoned = applyDispositionTransition(extension(), 'abandoned', true, now);
    expect(() => applyDispositionTransition(abandoned, 'active', true, now)).toThrow('standing-drive-terminal');
  });

  it('implements ANY-source-stop-wins and unreadable-as-hold', () => {
    expect(composeStopDecision([true, false, false]).stopped).toBe(true);
    expect(composeStopDecision([false, true, false]).stopped).toBe(true);
    expect(composeStopDecision([false, false, true]).stopped).toBe(true);
    expect(composeStopDecision([false, 'unreadable', false])).toEqual({ stopped: true, reason: 'stop-evidence-unreadable' });
    expect(composeStopDecision([false, false, false]).stopped).toBe(false);
  });
});

describe('AutonomousRunStore composition and revision CAS', () => {
  let tmp: string;
  let store: AutonomousRunStore;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-drive-')); store = new AutonomousRunStore(tmp); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function register(topicId = '458') {
    const r = store.register({ topicId, condition: 'test', workDir: tmp, startedAt: now, scopeAccretion: { enabled: true, breakerK: 3 }, baseRoots: [], maxDurationMs: 60_000 });
    if (!r.ok) throw new Error('register failed');
    return r;
  }

  it('keeps plain autonomous runs compatible when extension is absent', () => {
    const r = register();
    const rec = store.getByPair('458', r.runId)!;
    expect(rec.standingDrive).toBeUndefined();
    expect(store.isActive(rec)).toBe(true);
  });

  it('enrolls atomically and preserves extension across unrelated base updates', () => {
    const r = register();
    store.enrollStandingDrive('458', r.runId, extension());
    store.update('458', r.runId, (rec) => { rec.condition = 'updated'; });
    expect(store.getByPair('458', r.runId)!.standingDrive).toEqual(extension());
  });

  it('requires every extension mutation to check and bump the shared revision', () => {
    const r = register();
    store.enrollStandingDrive('458', r.runId, extension());
    const updated = store.mutateStandingDrive('458', r.runId, 1, (ext) => ({ ...ext, breaker: { state: 'tripped', consecutiveNoProgress: 1 }, revision: 2 }));
    expect(updated.standingDrive?.revision).toBe(2);
    expect(() => store.mutateStandingDrive('458', r.runId, 1, (ext) => ({ ...ext, revision: 2 }))).toThrow('standing-drive-revision-conflict');
    expect(() => store.mutateStandingDrive('458', r.runId, 2, (ext) => ({ ...ext, disposition: { state: 'stopped' }, revision: 2 }))).toThrow('standing-drive-revision-not-bumped');
  });

  it('refuses extension writes through the generic updater', () => {
    const r = register();
    store.enrollStandingDrive('458', r.runId, extension());
    expect(() => store.update('458', r.runId, (rec) => { rec.standingDrive!.revision = 2; })).toThrow('standing-drive-mutation-requires-cas');
    expect(store.getByPair('458', r.runId)!.standingDrive?.revision).toBe(1);
  });

  it('reclaims a crash-left stale lock for plain-run updates', () => {
    const r = register();
    const lockDir = path.join(store.storeDir, `458.${r.runId}.json.lock`);
    fs.mkdirSync(lockDir);
    const stale = new Date(Date.now() - 20_000);
    fs.utimesSync(lockDir, stale, stale);
    expect(store.update('458', r.runId, (rec) => { rec.condition = 'recovered'; })?.condition).toBe('recovered');
    expect(store.getByPair('458', r.runId)?.standingDrive).toBeUndefined();
  });

  it('maps live lock contention to the stable mutation-busy contract', () => {
    const r = register();
    const lockDir = path.join(store.storeDir, `458.${r.runId}.json.lock`);
    fs.mkdirSync(lockDir);
    expect(() => store.update('458', r.runId, (rec) => { rec.condition = 'must-not-write'; })).toThrow('standing-drive-mutation-busy');
    expect(store.getByPair('458', r.runId)?.condition).toBe('test');
  });
});
