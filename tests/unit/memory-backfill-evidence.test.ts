/**
 * Tests for `instar memory backfill-evidence` (WikiClaim Phase 5).
 *
 * Spec citations:
 *   - § Migration of Existing MemoryEntity Records (line 202)
 *   - § Risks line 357 (no LLM, only known patterns, idempotent)
 *   - § Risks line 360 (no auto-upgrade of privacyTier)
 *   - § Producers line 229 (manual producer narrowed to external-url)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SemanticMemory, EvidencePolicyError } from '../../src/memory/SemanticMemory.js';
import { backfillAgainstMemory } from '../../src/commands/memoryBackfillEvidence.js';

interface Setup {
  dir: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function setup(): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-backfill-test-'));
  const memory = new SemanticMemory({
    dbPath: path.join(dir, 'semantic.db'),
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
  return {
    dir,
    memory,
    cleanup: () => {
      memory.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/memory-backfill-evidence.test.ts',
      });
    },
  };
}

const baseEntity = {
  type: 'fact' as const,
  name: 'test-entity',
  content: 'some content',
  confidence: 0.9,
  lastVerified: '2026-05-09T00:00:00Z',
  tags: ['test'],
  privacyScope: 'shared-project' as const,
};

describe('backfill-evidence — pattern matching', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('https URL source → external-url evidence row', () => {
    const id = s.memory.remember({
      ...baseEntity,
      source: 'https://example.com/doc/42',
    });

    const summary = backfillAgainstMemory(s.memory, {});

    expect(summary.scanned).toBe(1);
    expect(summary.backfilled).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);

    const evidence = s.memory.getEvidence(id, 'private');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].kind).toBe('external-url');
    expect(evidence[0].sourceId).toBe('https://example.com/doc/42');
    expect(evidence[0].path).toBe('https://example.com/doc/42');
    // Privacy must inherit from entity — never auto-upgrade
    expect(evidence[0].privacyTier).toBeUndefined();
  });

  it('http URL source → external-url evidence row', () => {
    const id = s.memory.remember({
      ...baseEntity,
      source: 'http://localhost:4042/api/x?y=z',
    });

    const summary = backfillAgainstMemory(s.memory, {});

    expect(summary.backfilled).toBe(1);
    const evidence = s.memory.getEvidence(id, 'private');
    expect(evidence[0].path).toBe('http://localhost:4042/api/x?y=z');
  });

  it.each([
    ['session:ABC123'],
    ['user:Justin'],
    ['observation'],
    ['cluster-builder'],
    ['see https://example.com inside text'], // URL embedded, not anchored
    [''], // empty
    ['  https://leading-whitespace.com  '], // whitespace not stripped
  ])('non-URL source %j → skip, no evidence', (source) => {
    const id = s.memory.remember({ ...baseEntity, source });

    const summary = backfillAgainstMemory(s.memory, {});

    expect(summary.scanned).toBe(1);
    expect(summary.backfilled).toBe(0);
    expect(summary.skipped).toBe(1);

    const evidence = s.memory.getEvidence(id, 'private');
    expect(evidence).toHaveLength(0);
  });
});

describe('backfill-evidence — producer narrowing respected', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('only writes external-url kind (never feedback / session / etc.)', () => {
    const id = s.memory.remember({
      ...baseEntity,
      source: 'https://example.com/x',
    });

    backfillAgainstMemory(s.memory, {});

    const evidence = s.memory.getEvidence(id, 'private');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].kind).toBe('external-url');
    // Sanity: manual producer can only write external-url. Attempting any
    // other kind via manual should throw — verifies our test trusts the
    // allowlist correctly.
    expect(() =>
      s.memory.addEvidence(
        id,
        {
          kind: 'feedback',
          sourceId: 'fb_x',
          updatedAt: '2026-05-09T00:00:00Z',
        },
        'manual',
      ),
    ).toThrow(EvidencePolicyError);
  });
});

describe('backfill-evidence — idempotency', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('second run produces zero additional writes', () => {
    s.memory.remember({ ...baseEntity, source: 'https://example.com/x' });
    s.memory.remember({ ...baseEntity, name: 'b', source: 'https://example.com/y' });
    s.memory.remember({ ...baseEntity, name: 'c', source: 'session:ABC' });

    const first = backfillAgainstMemory(s.memory, {});
    expect(first.backfilled).toBe(2);

    const second = backfillAgainstMemory(s.memory, {});
    expect(second.scanned).toBe(3);
    expect(second.backfilled).toBe(0);
    expect(second.skipped).toBe(3); // 2 already-have + 1 no-pattern-match
  });

  it('idempotency holds across entity privacy tiers', () => {
    // Private entity with URL source — dup-check must read at viewer 'private'
    // (the default) so it sees its own private-scope row on second run.
    const id = s.memory.remember({
      ...baseEntity,
      privacyScope: 'private',
      source: 'https://example.com/secret',
    });

    backfillAgainstMemory(s.memory, {});
    backfillAgainstMemory(s.memory, {});

    const evidence = s.memory.getEvidence(id, 'private');
    expect(evidence).toHaveLength(1);
  });
});

describe('backfill-evidence — dry-run', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('reports what would be backfilled without writing', () => {
    const id = s.memory.remember({
      ...baseEntity,
      source: 'https://example.com/x',
    });

    const summary = backfillAgainstMemory(s.memory, { dryRun: true });

    expect(summary.backfilled).toBe(1);
    expect(summary.details[0]).toMatchObject({
      entityId: id,
      outcome: 'backfilled',
      note: 'dry-run (not written)',
    });

    // Crucially: nothing was written
    const evidence = s.memory.getEvidence(id, 'private');
    expect(evidence).toHaveLength(0);
  });

  it('subsequent apply-run after dry-run still writes (dry-run is non-mutating)', () => {
    const id = s.memory.remember({
      ...baseEntity,
      source: 'https://example.com/x',
    });

    backfillAgainstMemory(s.memory, { dryRun: true });
    expect(s.memory.getEvidence(id, 'private')).toHaveLength(0);

    const apply = backfillAgainstMemory(s.memory, {});
    expect(apply.backfilled).toBe(1);
    expect(s.memory.getEvidence(id, 'private')).toHaveLength(1);
  });
});

describe('backfill-evidence — privacy defaults', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it.each([
    ['shared-project'],
    ['shared-topic'],
    ['private'],
  ] as const)(
    'entity at %s scope → evidence privacyTier undefined (inherits)',
    (scope) => {
      const id = s.memory.remember({
        ...baseEntity,
        privacyScope: scope,
        source: 'https://example.com/x',
      });

      backfillAgainstMemory(s.memory, {});

      const evidence = s.memory.getEvidence(id, 'private');
      expect(evidence).toHaveLength(1);
      expect(evidence[0].privacyTier).toBeUndefined();
    },
  );
});
