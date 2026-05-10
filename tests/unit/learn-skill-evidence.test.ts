/**
 * WikiClaim Phase 3 — /learn skill evidence bridge.
 *
 * Spec source: docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md
 *   § Producers line 268 (Lesson capture must cite ≥1 evidence row)
 *   § Producers line 228 (LearnSkill allowlist: message|session)
 *   § Migration Plan line 341 (Phase 3: /learn auto-derives or prompts)
 *
 * Covers:
 *   - Auto-derive `feedback` external reference from fb_<hex> patterns
 *   - Auto-derive `commit` external reference from 40-char SHA
 *   - Auto-derive `session` evidence from UUID v4 and sess_<hex>
 *   - documentFallback when nothing auto-derivable
 *   - LearnEvidenceError when no derivation and no fallback
 *   - Producer-kind allowlist enforcement (LearnSkill cannot write `feedback`)
 *   - Deduplication of repeated references
 *
 * Tests run against the LearnSkillBridge module + real SemanticMemory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  deriveEvidenceFromContext,
  buildLearnEvidence,
  LearnEvidenceError,
} from '../../src/core/LearnSkillBridge.js';
import { SemanticMemory, EvidencePolicyError } from '../../src/memory/SemanticMemory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = '2026-05-10T00:00:00Z';

describe('LearnSkillBridge — deriveEvidenceFromContext', () => {
  it('extracts feedback ID into externalReferences (LearnSkill cannot write `feedback`)', () => {
    const r = deriveEvidenceFromContext(
      'This was confirmed by fb_abc12345 — see report.',
      NOW,
    );
    expect(r.externalReferences).toEqual([{ kind: 'feedback', sourceId: 'fb_abc12345' }]);
    // No `feedback` rows in evidence — LearnSkill allowlist (spec line 228)
    // restricts to message|session.
    expect(r.evidence.find(e => e.kind === 'feedback' as unknown)).toBeUndefined();
  });

  it('extracts commit SHA (40-hex) into externalReferences', () => {
    const sha = 'a'.repeat(40);
    const r = deriveEvidenceFromContext(`Fixed in commit ${sha}.`, NOW);
    expect(r.externalReferences).toEqual([{ kind: 'commit', sourceId: sha }]);
  });

  it('extracts session UUID v4 into `session` evidence row', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const r = deriveEvidenceFromContext(`From session ${uuid} earlier today.`, NOW);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({
      kind: 'session',
      sourceId: uuid,
      updatedAt: NOW,
    });
  });

  it('extracts sess_<hex> session ID into `session` evidence row', () => {
    const r = deriveEvidenceFromContext('Refer to sess_deadbeef99 for context.', NOW);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].kind).toBe('session');
    expect(r.evidence[0].sourceId).toBe('sess_deadbeef99');
  });

  it('deduplicates repeated references', () => {
    const r = deriveEvidenceFromContext(
      'sess_abc12345 mentioned earlier — also sess_abc12345 again. fb_dead0000 + fb_dead0000.',
      NOW,
    );
    expect(r.evidence.filter(e => e.kind === 'session')).toHaveLength(1);
    expect(r.externalReferences.filter(e => e.kind === 'feedback')).toHaveLength(1);
  });

  it('returns empty result for unparseable input', () => {
    const r = deriveEvidenceFromContext('Just a vague thought, no IDs.', NOW);
    // No structured refs detected.
    expect(r.externalReferences).toEqual([]);
    // Sessions only — no inline-message synthesis at this layer.
    expect(r.evidence).toEqual([]);
  });

  it('handles empty/falsy context safely', () => {
    expect(deriveEvidenceFromContext('', NOW)).toEqual({ evidence: [], externalReferences: [] });
    expect(deriveEvidenceFromContext(
      null as unknown as string, NOW,
    )).toEqual({ evidence: [], externalReferences: [] });
  });

  it('combines all pattern kinds into a single result', () => {
    const sha = 'b'.repeat(40);
    const r = deriveEvidenceFromContext(
      `Built from fb_aaa00111, sess_abc12345, commit ${sha}.`,
      NOW,
    );
    expect(r.externalReferences).toHaveLength(2);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].kind).toBe('session');
  });
});

describe('LearnSkillBridge — buildLearnEvidence', () => {
  it('returns auto-derived session as the writable evidence row', () => {
    const built = buildLearnEvidence({
      context: 'During sess_abc1234545 we found the regression.',
      now: NOW,
    });
    expect(built.evidence).toHaveLength(1);
    expect(built.evidence[0].kind).toBe('session');
    expect(built.pendingDocumentRef).toBeUndefined();
  });

  it('synthesizes an inline `message` row when context is non-empty but unstructured', () => {
    const built = buildLearnEvidence({
      context: 'I learned that the tone gate sometimes paraphrases when it should not.',
      now: NOW,
    });
    expect(built.evidence).toHaveLength(1);
    expect(built.evidence[0].kind).toBe('message');
    expect(built.evidence[0].sourceId).toMatch(/^inline:/);
    expect(built.evidence[0].note).toBeTruthy();
  });

  it('throws LearnEvidenceError when context is empty and no fallback provided', () => {
    expect(() => buildLearnEvidence({ context: '', now: NOW })).toThrow(LearnEvidenceError);
  });

  it('returns pendingDocumentRef when context is empty but fallback is provided', () => {
    const built = buildLearnEvidence({
      context: '',
      documentFallback: { sourceId: 'docs/RUNBOOK.md', path: 'docs/RUNBOOK.md' },
      now: NOW,
    });
    expect(built.pendingDocumentRef).toEqual({
      sourceId: 'docs/RUNBOOK.md',
      path: 'docs/RUNBOOK.md',
    });
  });

  it('surfaces externalReferences alongside the evidence array', () => {
    const built = buildLearnEvidence({
      context: 'Per fb_abc12345 and commit ' + 'c'.repeat(40),
      now: NOW,
    });
    expect(built.externalReferences).toHaveLength(2);
    expect(built.externalReferences.map(r => r.kind).sort()).toEqual(['commit', 'feedback']);
  });
});

describe('LearnSkillBridge — SemanticMemory producer-kind allowlist enforcement', () => {
  let dir: string;
  let memory: SemanticMemory;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-evidence-test-'));
    memory = new SemanticMemory({
      dbPath: path.join(dir, 'semantic.db'),
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await memory.open();
  });

  afterEach(() => {
    memory.close();
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true,
      operation: 'tests/unit/learn-skill-evidence.test.ts',
    });
  });

  it('LearnSkill producer can write `session` kind via rememberWithEvidence', () => {
    const built = buildLearnEvidence({
      context: 'Insight from sess_abc1234545.',
      now: NOW,
    });
    const id = memory.rememberWithEvidence(
      {
        type: 'lesson',
        name: 'Tone-gate paraphrase pattern',
        content: 'Tone gate sometimes paraphrases when it should not',
        confidence: 0.7,
        lastVerified: NOW,
        source: '/learn',
        tags: ['lesson'],
        privacyScope: 'shared-project',
      },
      built.evidence,
      'LearnSkill',
    );
    const got = memory.getEvidence(id, 'shared-project');
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe('session');
  });

  it('LearnSkill producer can write `message` kind via inline synthesis', () => {
    const built = buildLearnEvidence({
      context: 'Just a freeform lesson without structured refs.',
      now: NOW,
    });
    const id = memory.rememberWithEvidence(
      {
        type: 'lesson',
        name: 'Inline-only',
        content: 'A lesson',
        confidence: 0.5,
        lastVerified: NOW,
        source: '/learn',
        tags: ['lesson'],
        privacyScope: 'shared-project',
      },
      built.evidence,
      'LearnSkill',
    );
    const got = memory.getEvidence(id, 'shared-project');
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe('message');
  });

  it('LearnSkill CANNOT write `feedback` kind (allowlist enforcement)', () => {
    expect(() =>
      memory.rememberWithEvidence(
        {
          type: 'lesson',
          name: 'attempt to write feedback',
          content: 'x',
          confidence: 0.5,
          lastVerified: NOW,
          source: '/learn',
          tags: [],
          privacyScope: 'shared-project',
        },
        [{ kind: 'feedback', sourceId: 'fb_x', updatedAt: NOW }],
        'LearnSkill',
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('LearnSkill CANNOT write `commit` kind (allowlist enforcement)', () => {
    expect(() =>
      memory.rememberWithEvidence(
        {
          type: 'lesson',
          name: 'attempt to write commit',
          content: 'x',
          confidence: 0.5,
          lastVerified: NOW,
          source: '/learn',
          tags: [],
          privacyScope: 'shared-project',
        },
        [{ kind: 'commit', sourceId: 'd'.repeat(40), updatedAt: NOW }],
        'LearnSkill',
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('LearnSkill CANNOT write `ledger-entry` kind (only DecisionJournal / DispatchExecutor)', () => {
    expect(() =>
      memory.rememberWithEvidence(
        {
          type: 'lesson',
          name: 'attempt to write ledger-entry',
          content: 'x',
          confidence: 0.5,
          lastVerified: NOW,
          source: '/learn',
          tags: [],
          privacyScope: 'shared-project',
        },
        [{ kind: 'ledger-entry', sourceId: 'led_x', updatedAt: NOW }],
        'LearnSkill',
      ),
    ).toThrow(EvidencePolicyError);
  });

  it('findCitations() locates the lesson via its session evidence', () => {
    const built = buildLearnEvidence({
      context: 'Insight from sess_f10ddead.',
      now: NOW,
    });
    const id = memory.rememberWithEvidence(
      {
        type: 'lesson',
        name: 'findable',
        content: 'lesson',
        confidence: 0.7,
        lastVerified: NOW,
        source: '/learn',
        tags: [],
        privacyScope: 'shared-project',
      },
      built.evidence,
      'LearnSkill',
    );
    const cites = memory.findCitations(
      { kind: 'session', sourceId: 'sess_f10ddead' },
      'shared-project',
    );
    expect(cites.map(c => c.id)).toContain(id);
  });
});
