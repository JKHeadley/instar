// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests for ApprenticeshipProgram (Apprenticeship Step 1). Exercises BOTH
 * sides of every decision boundary with realistic inputs (Testing Integrity):
 *   - the retro-gate (start) and doc-as-required-artifact gate (completion)
 *   - the status transition table (legal allowed, illegal rejected, complete terminal)
 *   - charset clamp + dup-reject on create
 *   - path-confinement (a traversal harvestRef is ignored; the canonical path is used)
 *   - wiring-integrity (the injected validator + ledger-counter are REAL, not no-ops)
 *   - partial-accepted with/without acceptance metadata
 *
 * The gates re-derive truth from injected deps; tests inject controllable fakes
 * AND one real-fs/real-validator path so the wiring is proven non-no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprenticeshipProgram,
  noopApprenticeshipOverseer,
  type GateDeps,
  type ApprenticeshipInstance,
} from '../../src/core/ApprenticeshipProgram';
import { validateRetroHarvest } from '../../src/core/retroHarvestValidator';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor';

const SCHEMA_ID = 'apprenticeship-retro-harvest/v1';

/** Build a VALID harvest artifact (mentor→mentee edge), with overrides. */
function buildHarvest(fmOverrides: Record<string, unknown> = {}, body?: string): string {
  const fm: Record<string, unknown> = {
    schema: SCHEMA_ID,
    instanceType: 'mentorship',
    from: 'echo',
    to: 'codey',
    framework: 'codex-cli',
    harvestedAt: '2026-06-02T03:00:00Z',
    scopeMode: 'full',
    completeness: 'complete',
    sourcesCovered: {
      ledger: { read: true, issueCount: 12 },
      playbook: { read: true, entryCount: 3 },
      memory: { read: true, files: 40 },
      threads: [{ id: 13435, messagesRead: 500, truncated: false }],
      prs: [666],
    },
    counts: { lessons: 1, metaLessons: 1, processInsights: 1 },
    seededToPlaybook: [],
    redaction: { scrubber: 'correction-scrub@v1', findingsRemoved: 2, scrubbedAt: '2026-06-02T03:00:00Z' },
    fidelityReview: { reviewer: 'claude-opus-independent', verdict: 'faithful', at: '2026-06-02T03:05:00Z' },
    programNeeds: 1,
    ...fmOverrides,
  };
  const yamlLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const defaultBody = [
    '## Lessons',
    '- A real lesson. ledger:4c4a8ded',
    '## Meta-lessons',
    '- A meta-lesson. thread:13435#m100',
    '## Process-insights',
    '- A process insight.',
    '## What the program needs',
    '- need-001 the differential read-channel.',
  ].join('\n');
  return `---\n${yamlLines}\n---\n\n${body ?? defaultBody}\n`;
}

/** Gate deps that satisfy completion (all live artifacts present). */
function passingDeps(harvestText: string): GateDeps {
  return {
    readHarvest: () => harvestText,
    validate: validateRetroHarvest,
    countInstanceLedgerEntries: () => 2,
    detectorAuditExists: () => true,
  };
}

describe('ApprenticeshipProgram', () => {
  let tmpDir: string;
  let stateDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apprenticeship-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/apprenticeship-program.test.ts:afterEach' });
  });

  function program(deps?: Partial<GateDeps>): ApprenticeshipProgram {
    return new ApprenticeshipProgram({ stateDir, projectDir, deps });
  }

  // ── createInstance: charset clamp + dup-reject ────────────────────────
  describe('createInstance', () => {
    it('creates a valid instance and computes harvestFrom=mentor / harvestTo=mentee', () => {
      const p = program();
      const inst = p.createInstance({
        id: 'echo-to-codey',
        instanceType: 'mentorship',
        overseer: 'echo',
        mentor: 'echo',
        mentee: 'codey',
        framework: 'codex-cli',
        priorInstanceId: null,
      });
      expect(inst.status).toBe('pending');
      expect(inst.ladderRung).toBe(0);
      expect(inst.rungHistory).toEqual([{ rung: 0, at: inst.createdAt, evidenceRef: 'instance-created' }]);
      expect(inst.harvestFrom).toBe('echo');
      expect(inst.harvestTo).toBe('codey');
      expect(inst.harvestRef).toBe('docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md');
      expect(inst.requiredArtifacts).toEqual({ retroHarvest: true, ledgerEntries: true, detectorAudit: true });
      expect(inst.version).toBe(0);
    });

    it('clamps charset — rejects an id/mentor with illegal chars', () => {
      const p = program();
      expect(() =>
        p.createInstance({ id: 'Echo/Codey', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' }),
      ).toThrow(/\^\[a-z0-9-\]\+\$/);
      expect(() =>
        p.createInstance({ id: 'ok-id', instanceType: 'mentorship', mentor: 'Echo!', mentee: 'codey', framework: 'codex-cli' }),
      ).toThrow(/mentor/);
    });

    it('rejects a duplicate id', () => {
      const p = program();
      p.createInstance({ id: 'dup', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      expect(() =>
        p.createInstance({ id: 'dup', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' }),
      ).toThrow(/duplicate id/);
    });

    it('persists across instances (file-backed store)', () => {
      const p1 = program();
      p1.createInstance({ id: 'persisted', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const p2 = program();
      expect(p2.get('persisted')).toBeTruthy();
      expect(p2.list()).toHaveLength(1);
    });
  });

  describe('independence ladder registry', () => {
    it('requires evidence, permits adjacent promotion/demotion, and appends history', () => {
      const p = program();
      const inst = p.createInstance({ id: 'ladder', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      expect(p.transitionRung(inst.id, 1, '').ok).toBe(false);
      expect(p.transitionRung(inst.id, 2, 'pr:1').ok).toBe(false);

      const promoted = p.transitionRung(inst.id, 1, 'cycles:5faea978; prs:1479,1480,1481');
      expect(promoted.ok).toBe(true);
      expect(promoted.instance?.ladderRung).toBe(1);
      expect(promoted.instance?.rungHistory).toHaveLength(2);
      expect(promoted.instance?.rungHistory[1]).toMatchObject({ rung: 1, evidenceRef: 'cycles:5faea978; prs:1479,1480,1481' });

      const demoted = p.transitionRung(inst.id, 0, 'cycle:queue-stall');
      expect(demoted.ok).toBe(true);
      expect(demoted.instance?.rungHistory.map((h) => h.rung)).toEqual([0, 1, 0]);
    });

    it('migrates a pre-ladder instance to R0 with durable provenance', () => {
      const p = program();
      p.createInstance({ id: 'legacy', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const storePath = path.join(stateDir, 'apprenticeship', 'instances.json');
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      delete store.instances[0].ladderRung;
      delete store.instances[0].rungHistory;
      fs.writeFileSync(storePath, JSON.stringify(store));

      const reloaded = program();
      expect(reloaded.get('legacy')?.ladderRung).toBe(0);
      expect(reloaded.get('legacy')?.rungHistory[0].evidenceRef).toBe('migration:pre-ladder-registry');
      const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      expect(persisted.instances[0].ladderRung).toBe(0);
    });

    it('fails closed when persisted ladder state is malformed', () => {
      const p = program();
      p.createInstance({ id: 'broken', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const storePath = path.join(stateDir, 'apprenticeship', 'instances.json');
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      store.instances[0].ladderRung = 99;
      store.instances[0].rungHistory = [];
      fs.writeFileSync(storePath, JSON.stringify(store));

      const reloaded = program();
      expect(reloaded.isCorrupt()).toBe(true);
      expect(reloaded.list()).toEqual([]);
    });

    it('audits refused and accepted rung transitions', () => {
      const p = program();
      const inst = p.createInstance({ id: 'ladder-audit', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      p.transitionRung(inst.id, 2, 'pr:skip');
      p.transitionRung(inst.id, 1, 'pr:accepted');
      const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
      const entries = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(entries.map((e) => [e.gate, e.allow])).toEqual([['ladder', false], ['ladder', true]]);
      expect(entries[1]).toMatchObject({ fromRung: 0, toRung: 1, evidenceRef: 'pr:accepted' });
    });
  });

  // ── evaluateStartGate (retro-gate) — both sides ───────────────────────
  describe('evaluateStartGate (retro-gate)', () => {
    function bootstrapInstance(p: ApprenticeshipProgram): ApprenticeshipInstance {
      return p.createInstance({
        id: 'echo-to-codey',
        instanceType: 'mentorship',
        overseer: 'echo',
        mentor: 'echo',
        mentee: 'codey',
        framework: 'codex-cli',
        priorInstanceId: null,
      });
    }

    it('ALLOWS bootstrap when the seed harvest exists + validates (complete)', () => {
      const p = program({ readHarvest: () => buildHarvest({ completeness: 'complete' }), validate: validateRetroHarvest });
      const inst = bootstrapInstance(p);
      const v = p.evaluateStartGate(inst);
      expect(v.allow).toBe(true);
    });

    it('REFUSES bootstrap when the seed harvest is missing', () => {
      const p = program({ readHarvest: () => null, validate: validateRetroHarvest });
      const inst = bootstrapInstance(p);
      const v = p.evaluateStartGate(inst);
      expect(v.allow).toBe(false);
      expect(v.reason).toMatch(/missing at canonical path/);
    });

    it('REFUSES bootstrap when the seed harvest is invalid', () => {
      const p = program({ readHarvest: () => buildHarvest({ schema: 'wrong/v9' }), validate: validateRetroHarvest });
      const inst = bootstrapInstance(p);
      const v = p.evaluateStartGate(inst);
      expect(v.allow).toBe(false);
      expect(v.reason).toMatch(/invalid/);
    });

    it('partial-accepted PASSES only with acceptance metadata', () => {
      const accepted = buildHarvest({
        completeness: 'partial-accepted',
        acceptedBy: 'justin',
        acceptedAt: '2026-06-02T04:33:00Z',
        // a partial harvest naturally has a truncated source — keep it valid
        sourcesCovered: {
          ledger: { read: true, issueCount: 12 },
          playbook: { read: true, entryCount: 3 },
          memory: { read: true, files: 40 },
          threads: [{ id: 13435, messagesRead: 200, truncated: true }],
          prs: [666],
        },
        fidelityReview: { reviewer: 'indep', verdict: 'partial', at: 'x', gaps: 'thread under-sampled' },
      });
      const p = program({ readHarvest: () => accepted, validate: validateRetroHarvest });
      const inst = bootstrapInstance(p);
      expect(p.evaluateStartGate(inst).allow).toBe(true);
    });

    it('partial-accepted REFUSES without acceptance metadata', () => {
      const unaccepted = buildHarvest({
        completeness: 'partial-accepted',
        sourcesCovered: {
          ledger: { read: true, issueCount: 12 },
          playbook: { read: true, entryCount: 3 },
          memory: { read: true, files: 40 },
          threads: [{ id: 13435, messagesRead: 200, truncated: true }],
          prs: [666],
        },
        fidelityReview: { reviewer: 'indep', verdict: 'partial', at: 'x', gaps: 'thread under-sampled' },
      });
      const p = program({ readHarvest: () => unaccepted, validate: validateRetroHarvest });
      const inst = bootstrapInstance(p);
      const v = p.evaluateStartGate(inst);
      expect(v.allow).toBe(false);
      expect(v.reason).toMatch(/awaiting acceptance/);
    });

    it('REFUSES a non-bootstrap instance when the prior instance is not complete', () => {
      const p = program({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest });
      const prior = p.createInstance({ id: 'prior', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const next = p.createInstance({
        id: 'next',
        instanceType: 'mentorship',
        overseer: 'echo',
        mentor: 'codey',
        mentee: 'gemini',
        framework: 'gemini-cli',
        priorInstanceId: prior.id,
      });
      const v = p.evaluateStartGate(next);
      expect(v.allow).toBe(false);
      expect(v.reason).toMatch(/must be "complete"/);
    });

    it('REFUSES a non-bootstrap instance when the prior id does not resolve', () => {
      const p = program({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest });
      const next = p.createInstance({
        id: 'orphan',
        instanceType: 'mentorship',
        mentor: 'codey',
        mentee: 'gemini',
        framework: 'gemini-cli',
        priorInstanceId: 'no-such-prior',
      });
      expect(p.evaluateStartGate(next).allow).toBe(false);
      expect(p.evaluateStartGate(next).reason).toMatch(/not found/);
    });
  });

  // ── evaluateCompletionGate (doc-gate) — both sides ────────────────────
  describe('evaluateCompletionGate (doc-as-required-artifact gate)', () => {
    function activeInstance(p: ApprenticeshipProgram): ApprenticeshipInstance {
      return p.createInstance({ id: 'inst', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
    }

    it('ALLOWS when ALL declared-required artifacts are present in live state', () => {
      const p = program(passingDeps(buildHarvest()));
      const inst = activeInstance(p);
      const v = p.evaluateCompletionGate(inst);
      expect(v.allow).toBe(true);
      expect(v.missing).toEqual([]);
    });

    it('REFUSES when the harvest is absent (live)', () => {
      const p = program({ ...passingDeps(buildHarvest()), readHarvest: () => null });
      const v = p.evaluateCompletionGate(activeInstance(p));
      expect(v.allow).toBe(false);
      expect(v.missing).toContain('retroHarvest:absent');
    });

    it('REFUSES when there are zero instance-scoped ledger entries', () => {
      const p = program({ ...passingDeps(buildHarvest()), countInstanceLedgerEntries: () => 0 });
      const v = p.evaluateCompletionGate(activeInstance(p));
      expect(v.allow).toBe(false);
      expect(v.missing).toContain('ledgerEntries:none');
    });

    it('REFUSES when the detector audit is absent', () => {
      const p = program({ ...passingDeps(buildHarvest()), detectorAuditExists: () => false });
      const v = p.evaluateCompletionGate(activeInstance(p));
      expect(v.allow).toBe(false);
      expect(v.missing).toContain('detectorAudit:absent');
    });

    it('NEVER trusts a stored requiredArtifacts flag — only declared-required artifacts are checked', () => {
      // Only ledgerEntries is declared required; harvest + detectorAudit not.
      const p = program({ readHarvest: () => null, validate: validateRetroHarvest, countInstanceLedgerEntries: () => 5, detectorAuditExists: () => false });
      const inst = p.createInstance({
        id: 'partial-req',
        instanceType: 'mentorship',
        mentor: 'echo',
        mentee: 'codey',
        framework: 'codex-cli',
        requiredArtifacts: { retroHarvest: false, ledgerEntries: true, detectorAudit: false },
      });
      const v = p.evaluateCompletionGate(inst);
      expect(v.allow).toBe(true); // harvest/detector not required → not checked
    });
  });

  // ── status transition table ───────────────────────────────────────────
  describe('transition table', () => {
    it('pending→abandoned retains the record as terminal disposal', () => {
      const p = program();
      const inst = p.createInstance({ id: 'mistake', instanceType: 'mentorship', mentor: 'echo', mentee: 'wrong', framework: 'codex-cli' });
      const r = p.transition(inst.id, 'abandoned');
      expect(r.ok).toBe(true);
      expect(p.get(inst.id)?.status).toBe('abandoned');
      expect(p.transition(inst.id, 'active').ok).toBe(false);
      expect(p.list().map((i) => i.id)).toContain('mistake');
    });

    it('refuses active→abandoned so disposal cannot erase started work', () => {
      const p = program({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest });
      const inst = p.createInstance({ id: 'started', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      expect(p.transition(inst.id, 'active').ok).toBe(true);
      const r = p.transition(inst.id, 'abandoned');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('illegal transition active→abandoned');
    });

    it('pending→active runs the start gate and refuses on !allow', () => {
      const p = program({ readHarvest: () => null, validate: validateRetroHarvest });
      const inst = p.createInstance({ id: 'i1', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const r = p.transition(inst.id, 'active');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/start gate refused/);
      expect(p.get(inst.id)!.status).toBe('pending');
    });

    it('pending→active succeeds when the start gate allows', () => {
      const p = program({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest });
      const inst = p.createInstance({ id: 'i2', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const r = p.transition(inst.id, 'active');
      expect(r.ok).toBe(true);
      expect(p.get(inst.id)!.status).toBe('active');
    });

    it('active→complete runs the completion gate and refuses on !allow', () => {
      const p = program({ readHarvest: () => buildHarvest(), validate: validateRetroHarvest, countInstanceLedgerEntries: () => 0, detectorAuditExists: () => true });
      const inst = p.createInstance({ id: 'i3', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      p.transition(inst.id, 'active');
      const r = p.transition(inst.id, 'complete');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/completion gate refused/);
    });

    it('active→complete succeeds and complete is TERMINAL', () => {
      const p = program(passingDeps(buildHarvest()));
      const inst = p.createInstance({ id: 'i4', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      p.transition(inst.id, 'active');
      expect(p.transition(inst.id, 'complete').ok).toBe(true);
      // terminal — no further transitions
      const back = p.transition(inst.id, 'active');
      expect(back.ok).toBe(false);
      expect(back.reason).toMatch(/illegal transition|terminal/);
    });

    it('active→blocked and blocked→active (re-gate) are legal', () => {
      const p = program(passingDeps(buildHarvest()));
      const inst = p.createInstance({ id: 'i5', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      p.transition(inst.id, 'active');
      expect(p.transition(inst.id, 'blocked').ok).toBe(true);
      expect(p.get(inst.id)!.status).toBe('blocked');
      // blocked→active re-gates (start gate); deps allow → ok
      expect(p.transition(inst.id, 'active').ok).toBe(true);
    });

    it('rejects an illegal transition (pending→complete)', () => {
      const p = program(passingDeps(buildHarvest()));
      const inst = p.createInstance({ id: 'i6', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const r = p.transition(inst.id, 'complete');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/illegal transition/);
    });

    it('requiredArtifacts is immutable after create (mutate restores it)', () => {
      const p = program(passingDeps(buildHarvest()));
      const inst = p.createInstance({ id: 'i7', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const before = JSON.stringify(inst.requiredArtifacts);
      p.transition(inst.id, 'active');
      expect(JSON.stringify(p.get(inst.id)!.requiredArtifacts)).toBe(before);
    });
  });

  // ── path confinement ──────────────────────────────────────────────────
  describe('path confinement', () => {
    it('ignores a stored traversal harvestRef — resolves via canonical path', () => {
      let readArg = '';
      const p = program({
        readHarvest: (rel) => {
          readArg = rel;
          return buildHarvest();
        },
        validate: validateRetroHarvest,
      });
      const inst = p.createInstance({ id: 'conf', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      // Forge a malicious stored harvestRef directly in the store file.
      const storePath = path.join(stateDir, 'apprenticeship', 'instances.json');
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      store.instances[0].harvestRef = '../../../../etc/passwd';
      fs.writeFileSync(storePath, JSON.stringify(store));
      // Re-load and gate — the canonical path must be used, not the forged ref.
      const p2 = program({
        readHarvest: (rel) => {
          readArg = rel;
          return buildHarvest();
        },
        validate: validateRetroHarvest,
      });
      const reloaded = p2.get('conf')!;
      expect(reloaded.harvestRef).toBe('../../../../etc/passwd'); // stored, but...
      p2.evaluateStartGate(reloaded);
      expect(readArg).toBe('docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md'); // ...never used
      expect(readArg).not.toContain('..');
    });
  });

  // ── wiring integrity ──────────────────────────────────────────────────
  describe('wiring integrity (deps are real, not no-ops)', () => {
    it('uses the REAL validator against a REAL on-disk harvest (default deps, no fakes)', () => {
      // Write a real harvest to the canonical path under projectDir and use the
      // DEFAULT readHarvest + validate (no injected fakes) — proves the real fs
      // reader + real validator are wired, not no-ops.
      const rel = 'docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md';
      const full = path.join(projectDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buildHarvest({ completeness: 'complete' }));
      const p = program(); // DEFAULT deps — real fs + real validator
      const inst = p.createInstance({ id: 'real', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      const v = p.evaluateStartGate(inst);
      expect(v.allow).toBe(true);
      // Now corrupt the on-disk harvest — the real validator must catch it.
      fs.writeFileSync(full, '# not a valid harvest, no frontmatter');
      expect(p.evaluateStartGate(inst).allow).toBe(false);
    });

    it('the default ledger-counter is a real function (returns 0 by default, not undefined)', () => {
      const p = program(); // default countInstanceLedgerEntries
      const inst = p.createInstance({ id: 'wiring', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      // No harvest on disk → completion blocked, and ledger count defaults to 0.
      const v = p.evaluateCompletionGate(inst);
      expect(v.allow).toBe(false);
      expect(v.missing).toContain('ledgerEntries:none');
    });
  });

  // ── decision audit ────────────────────────────────────────────────────
  describe('decision audit', () => {
    it('appends a gate verdict line to logs/apprenticeship-decisions.jsonl', () => {
      const p = program({ readHarvest: () => null, validate: validateRetroHarvest });
      const inst = p.createInstance({ id: 'audit', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' });
      p.transition(inst.id, 'active'); // refused → audited
      const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[0]);
      expect(entry.gate).toBe('start');
      expect(entry.instanceId).toBe('audit');
      expect(entry.allow).toBe(false);
    });
  });

  // ── corrupt store fails closed ────────────────────────────────────────
  describe('fail-closed on corrupt store', () => {
    it('a corrupt store refuses gates and create', () => {
      const storePath = path.join(stateDir, 'apprenticeship', 'instances.json');
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, '{ this is not valid json ]');
      const p = program();
      expect(p.isCorrupt()).toBe(true);
      expect(() => p.createInstance({ id: 'x', instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli' })).toThrow(/corrupt/);
    });
  });

  // ── overseer stub ─────────────────────────────────────────────────────
  describe('ApprenticeshipOverseer no-op stub (Step-4 location resolved)', () => {
    it('computeDifferential returns an explicit not-implemented marker (never silent)', () => {
      const inst = {
        id: 'x', instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey',
        framework: 'codex-cli', status: 'active', priorInstanceId: null,
        requiredArtifacts: { retroHarvest: true, ledgerEntries: true, detectorAudit: true },
        programNeeds: [], harvestFrom: 'echo', harvestTo: 'codey', harvestRef: null,
        version: 0, createdAt: 'x', updatedAt: 'x',
      } as ApprenticeshipInstance;
      const r = noopApprenticeshipOverseer.computeDifferential(inst);
      expect(r.implemented).toBe(false);
      expect(r.reason).toMatch(/Step 4|need-001/);
    });
  });
});
