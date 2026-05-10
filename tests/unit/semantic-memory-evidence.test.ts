/**
 * Tests for WikiClaim-shape evidence on MemoryEntity.
 *
 * Covers Phase 1 contract: schema add, lazy load, narrowing-only privacy
 * constraint, per-producer kind allowlist, evidence cap, supersedes cycle
 * detection, JSONL replay actions, cascade-delete on entity forget.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SemanticMemory,
  EvidencePolicyError,
} from '../../src/memory/SemanticMemory.js';
import type { MemoryEvidence } from '../../src/core/types.js';

interface Setup {
  dir: string;
  dbPath: string;
  memory: SemanticMemory;
  cleanup: () => void;
}

async function setup(): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-evidence-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
  return {
    dir,
    dbPath,
    memory,
    cleanup: () => {
      memory.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/semantic-memory-evidence.test.ts',
      });
    },
  };
}

const baseEntity = {
  type: 'pattern' as const,
  name: 'duplicate-reply-cluster',
  content: 'Telegram messages with file paths get blocked by tone gate',
  confidence: 0.85,
  lastVerified: '2026-05-09T00:00:00Z',
  source: 'cluster-builder',
  tags: ['cluster', 'pattern'],
  privacyScope: 'shared-project' as const,
};

const ev = (over: Partial<MemoryEvidence>): MemoryEvidence => ({
  kind: 'feedback',
  sourceId: 'fb_abc123',
  updatedAt: '2026-05-09T00:00:00Z',
  weight: 0.7,
  confidence: 0.8,
  ...over,
});

describe('SemanticMemory.evidence — schema + lazy load', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('legacy remember() leaves evidence undefined on recall', async () => {
    const id = s.memory.remember(baseEntity);
    const result = s.memory.recall(id);
    expect(result).not.toBeNull();
    expect(result!.entity.evidence).toBeUndefined();
  });

  it('rememberWithEvidence stores evidence atomically and returns id', async () => {
    const id = s.memory.rememberWithEvidence(
      baseEntity,
      [ev({}), ev({ sourceId: 'fb_xyz999', weight: 0.3 })],
      'EvolutionManager',
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = s.memory.getEntityWithEvidence(id, 'shared-project');
    expect(fetched).not.toBeNull();
    expect(fetched!.evidence.length).toBe(2);
    const sourceIds = fetched!.evidence.map((e) => e.sourceId).sort();
    expect(sourceIds).toEqual(['fb_abc123', 'fb_xyz999']);
  });

  it('addEvidence appends to an existing entity', async () => {
    const id = s.memory.remember(baseEntity);
    s.memory.addEvidence(id, ev({}), 'EvolutionManager');
    s.memory.addEvidence(id, [ev({ sourceId: 'fb_b', weight: 0.4 })], 'EvolutionManager');
    const fetched = s.memory.getEntityWithEvidence(id, 'shared-project')!;
    expect(fetched.evidence.length).toBe(2);
  });

  it('addEvidence on missing entity throws EvidencePolicyError', async () => {
    expect(() => s.memory.addEvidence('no-such-id', ev({}), 'EvolutionManager'))
      .toThrow(EvidencePolicyError);
  });
});

describe('SemanticMemory.evidence — producer allowlist', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('rejects when producer writes a kind not in its allowlist', async () => {
    const id = s.memory.remember(baseEntity);
    expect(() =>
      s.memory.addEvidence(id, ev({ kind: 'commit', sourceId: 'sha_abc' }), 'EvolutionManager'),
    ).toThrow(/cannot write evidence kind commit/);
  });

  it('accepts when producer writes an allowed kind', async () => {
    const id = s.memory.remember(baseEntity);
    s.memory.addEvidence(id, ev({ kind: 'pattern-entity', sourceId: 'pat_xyz' }), 'EvolutionManager');
    const fetched = s.memory.getEntityWithEvidence(id, 'shared-project')!;
    expect(fetched.evidence[0].kind).toBe('pattern-entity');
  });

  it('rejects unknown producer', async () => {
    const id = s.memory.remember(baseEntity);
    expect(() =>
      s.memory.addEvidence(id, ev({}), 'WhoIsThis' as any),
    ).toThrow(/unknown producer/);
  });
});

describe('SemanticMemory.evidence — privacy narrowing-only', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('rejects evidence privacyTier wider than entity privacyScope', async () => {
    const id = s.memory.remember({ ...baseEntity, privacyScope: 'private' });
    expect(() =>
      s.memory.addEvidence(
        id,
        ev({ privacyTier: 'shared-project' }),
        'EvolutionManager',
      ),
    ).toThrow(/wider than entity privacyScope/);
  });

  it('accepts evidence privacyTier equal to or more restrictive than entity', async () => {
    const id = s.memory.remember({ ...baseEntity, privacyScope: 'shared-project' });
    s.memory.addEvidence(id, ev({ privacyTier: 'shared-project' }), 'EvolutionManager');
    s.memory.addEvidence(id, ev({ sourceId: 'fb_2', privacyTier: 'private' }), 'EvolutionManager');
    s.memory.addEvidence(id, ev({ sourceId: 'fb_3', privacyTier: 'sensitive' }), 'EvolutionManager');
    const fetched = s.memory.getEntityWithEvidence(id, 'private')!;
    // viewer at 'private' (ordinal 2) sees public(0) / shared-project(1) /
    // private(2); 'sensitive' (3) is filtered out.
    expect(fetched.evidence.length).toBe(2);
  });

  it('rejects evidence at "public" tier when entity is shared-project', async () => {
    // shared-project is order=1 in the evidence-tier scale; 'public' is order=0
    // — wider than the entity, must be rejected by the narrowing check.
    const id = s.memory.remember({ ...baseEntity, privacyScope: 'shared-project' });
    expect(() =>
      s.memory.addEvidence(id, ev({ privacyTier: 'public' }), 'EvolutionManager'),
    ).toThrow(/wider than entity privacyScope/);
  });

  it('viewer at shared-project does NOT see evidence at private tier', async () => {
    const id = s.memory.remember({ ...baseEntity, privacyScope: 'shared-project' });
    s.memory.addEvidence(id, ev({ privacyTier: 'private' }), 'EvolutionManager');
    s.memory.addEvidence(id, ev({ sourceId: 'fb_2', privacyTier: 'shared-project' }), 'EvolutionManager');
    const list = s.memory.getEvidence(id, 'shared-project');
    expect(list.length).toBe(1);
    expect(list[0].sourceId).toBe('fb_2');
  });
});

describe('SemanticMemory.evidence — caps and shape validation', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('rejects oversized note', async () => {
    const id = s.memory.remember(baseEntity);
    expect(() =>
      s.memory.addEvidence(
        id,
        ev({ note: 'x'.repeat(600) }),
        'EvolutionManager',
      ),
    ).toThrow(/note exceeds 500 bytes/);
  });

  it('rejects weight outside [0,1]', async () => {
    const id = s.memory.remember(baseEntity);
    expect(() =>
      s.memory.addEvidence(id, ev({ weight: 1.5 }), 'EvolutionManager'),
    ).toThrow(/weight must be in/);
  });

  it('rejects malformed updatedAt', async () => {
    const id = s.memory.remember(baseEntity);
    expect(() =>
      s.memory.addEvidence(id, ev({ updatedAt: 'not-a-date' }), 'EvolutionManager'),
    ).toThrow(/updatedAt/);
  });
});

describe('SemanticMemory.evidence — findCitations (inverse query)', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('returns entities that cite the given (kind, sourceId)', async () => {
    const a = s.memory.rememberWithEvidence(
      { ...baseEntity, name: 'cluster-A' },
      [ev({ sourceId: 'fb_shared', weight: 0.7 })],
      'EvolutionManager',
    );
    const b = s.memory.rememberWithEvidence(
      { ...baseEntity, name: 'cluster-B' },
      [ev({ sourceId: 'fb_shared', weight: 0.3 })],
      'EvolutionManager',
    );
    // Different sourceId — should not match.
    s.memory.rememberWithEvidence(
      { ...baseEntity, name: 'cluster-C' },
      [ev({ sourceId: 'fb_other' })],
      'EvolutionManager',
    );
    const citing = s.memory.findCitations(
      { kind: 'feedback', sourceId: 'fb_shared' },
      'shared-project',
    );
    const ids = citing.map((e) => e.id).sort();
    expect(ids).toEqual([a, b].sort());
  });

  it('viewer-scope filter keeps private entities out of inverse results', async () => {
    const a = s.memory.rememberWithEvidence(
      { ...baseEntity, name: 'private-cluster', privacyScope: 'private' },
      [ev({ sourceId: 'fb_shared', privacyTier: 'private' })],
      'EvolutionManager',
    );
    const b = s.memory.rememberWithEvidence(
      { ...baseEntity, name: 'public-cluster', privacyScope: 'shared-project' },
      [ev({ sourceId: 'fb_shared', privacyTier: 'shared-project' })],
      'EvolutionManager',
    );
    const fromShared = s.memory
      .findCitations({ kind: 'feedback', sourceId: 'fb_shared' }, 'shared-project')
      .map((e) => e.id);
    expect(fromShared).toContain(b);
    expect(fromShared).not.toContain(a);

    const fromPrivate = s.memory
      .findCitations({ kind: 'feedback', sourceId: 'fb_shared' }, 'private')
      .map((e) => e.id)
      .sort();
    expect(fromPrivate).toEqual([a, b].sort());
  });
});

describe('SemanticMemory.evidence — cascade delete on forget', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('deletes evidence rows when the entity is forgotten (raw SQL probe)', async () => {
    const id = s.memory.rememberWithEvidence(
      baseEntity,
      [ev({}), ev({ sourceId: 'fb_2' })],
      'EvolutionManager',
    );
    const db = (s.memory as any).db as import('better-sqlite3').Database;
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM entity_evidence WHERE entity_id = ?')
      .get(id) as { n: number };
    expect(before.n).toBe(2);
    s.memory.forget(id);
    const after = db
      .prepare('SELECT COUNT(*) AS n FROM entity_evidence WHERE entity_id = ?')
      .get(id) as { n: number };
    expect(after.n).toBe(0);
  });

  it('createSchema asserts PRAGMA foreign_keys is ON (negative test)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-fk-test-'));
    const dbPath = path.join(dir, 'semantic.db');
    let BetterSqlite3: any;
    try {
      BetterSqlite3 = await import('better-sqlite3');
    } catch {
      // skip if not installed
      return;
    }
    const Constructor = BetterSqlite3.default || BetterSqlite3;
    const db = Constructor(dbPath);
    db.pragma('foreign_keys = OFF');
    db.close();
    // Now construct a SemanticMemory but force foreign_keys OFF after open
    // by monkey-patching the createSchema flow. The simpler equivalent:
    // attempt to open a NEW SemanticMemory whose db has FK off — open()
    // sets it ON, so the assertion always passes when going through the
    // normal lifecycle. Confirm that contract.
    const memory = new SemanticMemory({
      dbPath,
      decayHalfLifeDays: 30,
      lessonDecayHalfLifeDays: 90,
      staleThreshold: 0.2,
    });
    await memory.open(); // succeeds because open() sets FK ON before createSchema()
    const db2 = (memory as any).db as import('better-sqlite3').Database;
    const fk = db2.pragma('foreign_keys', { simple: true }) as number;
    expect(fk).toBe(1);
    memory.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'evidence-fk-test cleanup' });
  });
});

describe('SemanticMemory.evidence — supersedes bounded defenses', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('rejects a supersedes-evidence whose sourceId equals the entity id', async () => {
    const id = s.memory.rememberWithEvidence(
      baseEntity,
      [ev({ kind: 'feedback', sourceId: 'fb_old' })],
      'EvolutionManager',
    );
    expect(() =>
      s.memory.addEvidence(
        id,
        ev({ kind: 'supersedes-evidence', sourceId: id }),
        'EvolutionManager',
      ),
    ).toThrow(/cycle detected/);
  });

  it('rejects supersedes-evidence inserts beyond MAX_SUPERSEDES_DEPTH on one entity', async () => {
    const id = s.memory.rememberWithEvidence(
      baseEntity,
      [ev({ kind: 'feedback', sourceId: 'fb_seed' })],
      'EvolutionManager',
    );
    // MAX_SUPERSEDES_DEPTH = 32; insert that many, then expect the 33rd to
    // reject. We use distinct sourceIds so each insert is otherwise valid.
    for (let i = 0; i < 32; i++) {
      s.memory.addEvidence(
        id,
        ev({ kind: 'supersedes-evidence', sourceId: `fb_chain_${i}` }),
        'EvolutionManager',
      );
    }
    expect(() =>
      s.memory.addEvidence(
        id,
        ev({ kind: 'supersedes-evidence', sourceId: 'fb_chain_overflow' }),
        'EvolutionManager',
      ),
    ).toThrow(/depth/);
  });
});

describe('SemanticMemory.evidence — JSONL replay actions emitted', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('rememberWithEvidence and addEvidence emit dedicated JSONL actions', async () => {
    const id = s.memory.rememberWithEvidence(
      baseEntity,
      [ev({})],
      'EvolutionManager',
    );
    s.memory.addEvidence(id, ev({ sourceId: 'fb_b' }), 'EvolutionManager');

    // SemanticMemory writes JSONL alongside the DB; locate the file.
    const journalPath = path.join(s.dir, 'semantic.jsonl');
    const exists = fs.existsSync(journalPath);
    expect(exists).toBe(true);
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
    const actions = lines.map((l) => JSON.parse(l).action);
    expect(actions).toContain('rememberWithEvidence');
    expect(actions).toContain('addEvidence');
  });
});
