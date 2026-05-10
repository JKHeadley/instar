/**
 * WikiClaim Phase 3 — DecisionJournal evidence gate.
 *
 * Spec source: docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md
 *   § Producers line 258 (Decision journal cites message/commit/ledger-entry/session)
 *   § Migration Plan line 339 (Phase 3: DecisionJournal requires at least one evidence row)
 *
 * Covers:
 *   - log() requires evidence; empty/missing rejects with EvidencePolicyError
 *   - Producer-kind allowlist enforced for DecisionJournal kinds
 *     (only message|commit|ledger-entry|session allowed)
 *   - SemanticMemory bridge promotes entry to `decision` MemoryEntity when wired
 *   - entityId back-reference stamped on JSONL row
 *   - Inverse query findCitations() can locate the decision via evidence
 *
 * Tests run against real better-sqlite3, no mocks (per /instar-dev constraint).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DecisionJournal } from '../../src/core/DecisionJournal.js';
import { SemanticMemory, EvidencePolicyError } from '../../src/memory/SemanticMemory.js';
import type { MemoryEvidence } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Setup {
  dir: string;
  stateDir: string;
  journal: DecisionJournal;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function setup(): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-evidence-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const memory = new SemanticMemory({
    dbPath: path.join(stateDir, 'semantic.db'),
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
  const journal = new DecisionJournal(stateDir);
  return {
    dir, stateDir, journal, memory,
    cleanup: () => {
      memory.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/decision-journal-evidence.test.ts',
      });
    },
  };
}

const validEv = (over: Partial<MemoryEvidence> = {}): MemoryEvidence => ({
  kind: 'message',
  sourceId: 'msg_abc',
  updatedAt: '2026-05-10T00:00:00Z',
  confidence: 0.8,
  ...over,
});

describe('DecisionJournal — evidence-required gate (Phase 3)', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('log() with valid evidence succeeds and persists the JSONL row', () => {
    const result = s.journal.log(
      { sessionId: 'sess-1', decision: 'Use REST over GraphQL' },
      [validEv()],
    );
    expect(result.decision).toBe('Use REST over GraphQL');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence?.[0].kind).toBe('message');
    expect(result.timestamp).toBeTruthy();

    const lines = fs.readFileSync(
      path.join(s.stateDir, 'decision-journal.jsonl'), 'utf-8',
    ).trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.evidence).toHaveLength(1);
  });

  it('log() with empty evidence array throws EvidencePolicyError', () => {
    expect(() =>
      s.journal.log({ sessionId: 'sess-x', decision: 'Should fail' }, []),
    ).toThrow(EvidencePolicyError);
  });

  it('log() with missing evidence (cast undefined) throws EvidencePolicyError', () => {
    expect(() =>
      s.journal.log(
        { sessionId: 'sess-x', decision: 'Should fail' },
        // Force runtime check — TS rejects this at compile time, which is the
        // structural gate. Runtime test ensures defense-in-depth.
        undefined as unknown as MemoryEvidence[],
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('persists no JSONL row when evidence gate rejects', () => {
    expect(() =>
      s.journal.log({ sessionId: 's', decision: 'fail' }, []),
    ).toThrow(EvidencePolicyError);
    const journalFile = path.join(s.stateDir, 'decision-journal.jsonl');
    // Lazy-create only fires inside log() after the evidence check passes;
    // a rejected call must NOT create the file.
    expect(fs.existsSync(journalFile)).toBe(false);
  });

  it('accepts all four DecisionJournal-allowed kinds: message, commit, ledger-entry, session', () => {
    const evidence: MemoryEvidence[] = [
      { kind: 'message',      sourceId: 'm1', updatedAt: '2026-05-10T00:00:00Z' },
      { kind: 'commit',       sourceId: 'a'.repeat(40), updatedAt: '2026-05-10T00:00:00Z' },
      { kind: 'ledger-entry', sourceId: 'led_1', updatedAt: '2026-05-10T00:00:00Z' },
      { kind: 'session',      sourceId: 'sess_1', updatedAt: '2026-05-10T00:00:00Z' },
    ];
    // Without SemanticMemory wired, the allowlist isn't reached — gate is at
    // the bridge layer. Wire it and verify all four kinds pass.
    s.journal.setSemanticMemory(s.memory);
    const result = s.journal.log(
      { sessionId: 's', decision: 'multi-kind' },
      evidence,
    );
    expect(result.entityId).toBeTruthy();
    const ev = s.memory.getEvidence(result.entityId!, 'shared-project');
    expect(ev.map(e => e.kind).sort()).toEqual(
      ['commit', 'ledger-entry', 'message', 'session'],
    );
  });
});

describe('DecisionJournal — SemanticMemory bridge', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('promotes the journal entry to a `decision` MemoryEntity when wired', () => {
    s.journal.setSemanticMemory(s.memory);
    const result = s.journal.log(
      { sessionId: 'sess-1', decision: 'Adopt new caching layer' },
      [validEv({ sourceId: 'msg_42' })],
    );
    expect(result.entityId).toBeTruthy();
    const recalled = s.memory.recall(result.entityId!);
    expect(recalled).not.toBeNull();
    expect(recalled!.entity.type).toBe('decision');
    expect(recalled!.entity.content).toBe('Adopt new caching layer');
    expect(recalled!.entity.source).toBe('session:sess-1');
  });

  it('does NOT create a MemoryEntity when SemanticMemory is not wired (legacy mode)', () => {
    // No setSemanticMemory call.
    const result = s.journal.log(
      { sessionId: 'sess-1', decision: 'Plain decision' },
      [validEv()],
    );
    expect(result.entityId).toBeUndefined();
    // Sanity: nothing was added to the DB.
    expect(s.memory.stats().totalEntities).toBe(0);
  });

  it('inverse query findCitations() locates the promoted decision via evidence', () => {
    s.journal.setSemanticMemory(s.memory);
    const result = s.journal.log(
      { sessionId: 's', decision: 'Decision X' },
      [{ kind: 'commit', sourceId: 'b'.repeat(40), updatedAt: '2026-05-10T00:00:00Z' }],
    );
    const cites = s.memory.findCitations(
      { kind: 'commit', sourceId: 'b'.repeat(40) },
      'shared-project',
    );
    expect(cites.map(e => e.id)).toContain(result.entityId);
  });

  it('rejects unauthorized kinds via PRODUCER_KIND_ALLOWLIST (allowlist enforced)', () => {
    s.journal.setSemanticMemory(s.memory);
    // `feedback` is NOT in the DecisionJournal allowlist (spec line 227);
    // it's reserved for EvolutionManager.
    expect(() =>
      s.journal.log(
        { sessionId: 's', decision: 'bad kind' },
        [{ kind: 'feedback', sourceId: 'fb_x', updatedAt: '2026-05-10T00:00:00Z' }],
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('rejects `pattern-entity` kind (reserved for EvolutionManager/DispatchExecutor)', () => {
    s.journal.setSemanticMemory(s.memory);
    expect(() =>
      s.journal.log(
        { sessionId: 's', decision: 'bad' },
        [{ kind: 'pattern-entity', sourceId: 'p1', updatedAt: '2026-05-10T00:00:00Z' }],
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('rejects `job-run` kind (reserved for DispatchExecutor)', () => {
    s.journal.setSemanticMemory(s.memory);
    expect(() =>
      s.journal.log(
        { sessionId: 's', decision: 'bad' },
        [{ kind: 'job-run', sourceId: 'job_1', updatedAt: '2026-05-10T00:00:00Z' }],
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('preserves narrowing-only privacy at the bridge boundary', () => {
    s.journal.setSemanticMemory(s.memory, 'shared-project');
    // Evidence tier `sensitive` is more restrictive than entity `shared-project`
    // → narrowing-only allows this. Test asserts no throw + row landed.
    const result = s.journal.log(
      { sessionId: 's', decision: 'narrowed' },
      [{
        kind: 'message', sourceId: 'm', updatedAt: '2026-05-10T00:00:00Z',
        privacyTier: 'sensitive',
      }],
    );
    expect(result.entityId).toBeTruthy();
  });

  it('rejects widening-only privacy violation at the bridge boundary', () => {
    s.journal.setSemanticMemory(s.memory, 'shared-project');
    // Tier `public` is WIDER than entity `shared-project` → narrowing-only violates.
    expect(() =>
      s.journal.log(
        { sessionId: 's', decision: 'widen attempt' },
        [{
          kind: 'message', sourceId: 'm', updatedAt: '2026-05-10T00:00:00Z',
          privacyTier: 'public',
        }],
      ),
    ).toThrow(EvidencePolicyError);
  });
});

describe('DecisionJournal — read/stats unaffected by Phase 3', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('read() returns entries with evidence field populated', () => {
    s.journal.log(
      { sessionId: 's1', decision: 'D1' },
      [validEv({ sourceId: 'm1' })],
    );
    s.journal.log(
      { sessionId: 's2', decision: 'D2' },
      [validEv({ sourceId: 'm2' })],
    );
    const entries = s.journal.read();
    expect(entries).toHaveLength(2);
    expect(entries.every(e => Array.isArray(e.evidence) && e.evidence!.length === 1)).toBe(true);
  });

  it('stats() unaffected by evidence presence', () => {
    s.journal.log(
      { sessionId: 's1', decision: 'D1', principle: 'caution', conflict: true },
      [validEv()],
    );
    const st = s.journal.stats();
    expect(st.count).toBe(1);
    expect(st.conflictCount).toBe(1);
    expect(st.topPrinciples[0].principle).toBe('caution');
  });
});
