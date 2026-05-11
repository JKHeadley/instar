/**
 * InitiativeTracker project-scope unit tests (Phase 1.1).
 *
 * Covers the project-layer additions to the Initiative type and tracker:
 *  - Idempotent `kind`/`schemaVersion` backfill on first load
 *  - `kind` immutability on update (KindImmutableError)
 *  - Bidirectional `parentProjectId` validation (InvalidParentProjectError)
 *  - OCC `ifMatch` enforcement (OccVersionMismatchError) + version bump
 *  - Serialization round-trip (byte-identical for unchanged records)
 *  - Extended status enum (paused / halted / awaiting-user)
 *  - Digest cache invalidator hook fires once per successful mutation
 *
 * Legacy-JSON path is exercised here. TaskFlow-enabled behavior reuses the
 * same code paths (the project-layer logic lives outside the TaskFlow
 * branch); a separate suite covers TaskFlow specifics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InitiativeTracker,
  KindImmutableError,
  OccVersionMismatchError,
  InvalidParentProjectError,
  type Initiative,
  type InitiativeCreateInput,
} from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let tracker: InitiativeTracker;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'initiatives-project-test-'));
  tracker = new InitiativeTracker(tmpDir);
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/InitiativeTracker.project.test.ts',
  });
});

function baseInput(id = 'demo'): InitiativeCreateInput {
  return {
    id,
    title: 'Demo Initiative',
    description: 'A worked example for project-scope tests.',
    phases: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
    ],
  };
}

function readFileRaw(): string {
  return fs.readFileSync(path.join(tmpDir, 'initiatives.json'), 'utf8');
}

function writeLegacyRecords(records: Array<Partial<Initiative>>): void {
  fs.writeFileSync(
    path.join(tmpDir, 'initiatives.json'),
    JSON.stringify({ initiatives: records }, null, 2)
  );
}

// ─── Backfill ──────────────────────────────────────────────────────────────

describe('backfill (Phase 1.1)', () => {
  it('writes kind:"task" + schemaVersion:1 to records missing kind on first load', () => {
    // Write a legacy-shaped record (no kind, no schemaVersion, no version).
    writeLegacyRecords([
      {
        id: 'legacy-a',
        title: 'Legacy A',
        description: 'pre-project-scope',
        status: 'active',
        phases: [{ id: 'p1', name: 'P1', status: 'pending' }],
        currentPhaseIndex: 0,
        lastTouchedAt: '2025-01-01T00:00:00.000Z',
        needsUser: false,
        blockers: [],
        links: [],
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ]);

    // Constructor triggers loadFromDisk → backfill.
    const t = new InitiativeTracker(tmpDir);
    const got = t.get('legacy-a');
    expect(got).toBeDefined();
    expect(got!.kind).toBe('task');
    expect(got!.schemaVersion).toBe(1);
  });

  it('does not touch records that already have kind', () => {
    writeLegacyRecords([
      {
        id: 'already-tagged',
        title: 'Already Tagged',
        description: 'has kind',
        status: 'active',
        phases: [{ id: 'p1', name: 'P1', status: 'pending' }],
        currentPhaseIndex: 0,
        lastTouchedAt: '2025-01-01T00:00:00.000Z',
        needsUser: false,
        blockers: [],
        links: [],
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        kind: 'project',
        schemaVersion: 7,
      },
    ]);

    const t = new InitiativeTracker(tmpDir);
    const got = t.get('already-tagged');
    expect(got!.kind).toBe('project');
    expect(got!.schemaVersion).toBe(7);
  });

  it('second load is byte-identical no-op', () => {
    writeLegacyRecords([
      {
        id: 'legacy-b',
        title: 'Legacy B',
        description: 'pre-project-scope',
        status: 'active',
        phases: [{ id: 'p1', name: 'P1', status: 'pending' }],
        currentPhaseIndex: 0,
        lastTouchedAt: '2025-01-01T00:00:00.000Z',
        needsUser: false,
        blockers: [],
        links: [],
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ]);

    // First load triggers backfill + rewrite.
    new InitiativeTracker(tmpDir);
    const afterFirst = readFileRaw();

    // Second load: nothing should change.
    new InitiativeTracker(tmpDir);
    const afterSecond = readFileRaw();

    expect(afterSecond).toBe(afterFirst);
  });
});

// ─── kind immutability ─────────────────────────────────────────────────────

describe('kind immutability (Phase 1.1)', () => {
  it('rejects update() that changes kind', async () => {
    await tracker.create(baseInput('k1'));
    // Created with default kind: 'task'. Try to flip to project.
    await expect(tracker.update('k1', { kind: 'project' })).rejects.toBeInstanceOf(
      KindImmutableError
    );
  });

  it('allows update() that passes the same kind (no-op)', async () => {
    await tracker.create(baseInput('k2'));
    const out = await tracker.update('k2', { kind: 'task' });
    expect(out.kind).toBe('task');
  });

  it('create() defaults kind to "task" when omitted', async () => {
    const out = await tracker.create(baseInput('k3'));
    expect(out.kind).toBe('task');
  });
});

// ─── parentProjectId bidirectional validation ──────────────────────────────

describe('parentProjectId validation (Phase 1.1)', () => {
  it('rejects setting parentProjectId to a non-existent project', async () => {
    await tracker.create(baseInput('child-1'));
    await expect(
      tracker.update('child-1', { parentProjectId: 'no-such-project' })
    ).rejects.toBeInstanceOf(InvalidParentProjectError);
  });

  it('rejects setting parentProjectId to a project that does not list this child', async () => {
    await tracker.create({
      ...baseInput('proj-a'),
      kind: 'project',
      rounds: [{ name: 'r1', itemIds: ['someone-else'], status: 'pending' }],
    });
    await tracker.create(baseInput('child-2'));
    await expect(
      tracker.update('child-2', { parentProjectId: 'proj-a' })
    ).rejects.toBeInstanceOf(InvalidParentProjectError);
  });

  it('rejects setting parentProjectId to a non-project initiative', async () => {
    await tracker.create(baseInput('not-a-project'));
    await tracker.create(baseInput('child-3'));
    await expect(
      tracker.update('child-3', { parentProjectId: 'not-a-project' })
    ).rejects.toBeInstanceOf(InvalidParentProjectError);
  });

  it('accepts setting parentProjectId when the project lists the child', async () => {
    await tracker.create({
      ...baseInput('proj-b'),
      kind: 'project',
      rounds: [{ name: 'r1', itemIds: ['child-4'], status: 'pending' }],
    });
    await tracker.create(baseInput('child-4'));
    const out = await tracker.update('child-4', { parentProjectId: 'proj-b' });
    expect(out.parentProjectId).toBe('proj-b');
  });

  it('accepts clearing parentProjectId (set to null)', async () => {
    await tracker.create({
      ...baseInput('proj-c'),
      kind: 'project',
      rounds: [{ name: 'r1', itemIds: ['child-5'], status: 'pending' }],
    });
    await tracker.create(baseInput('child-5'));
    await tracker.update('child-5', { parentProjectId: 'proj-c' });
    const cleared = await tracker.update('child-5', { parentProjectId: null });
    expect(cleared.parentProjectId).toBeUndefined();
  });
});

// ─── OCC / version field ───────────────────────────────────────────────────

describe('OCC (Phase 1.1)', () => {
  it('starts version at 1 on create', async () => {
    const out = await tracker.create(baseInput('occ-1'));
    expect(out.version).toBe(1);
  });

  it('increments version on every successful update', async () => {
    await tracker.create(baseInput('occ-2'));
    const v1 = await tracker.update('occ-2', { title: 'first' });
    expect(v1.version).toBe(2);
    const v2 = await tracker.update('occ-2', { title: 'second' });
    expect(v2.version).toBe(3);
    const v3 = await tracker.update('occ-2', { title: 'third' });
    expect(v3.version).toBe(4);
  });

  it('increments version on setPhaseStatus', async () => {
    await tracker.create(baseInput('occ-phase'));
    const out = await tracker.setPhaseStatus('occ-phase', 'plan', 'in-progress');
    expect(out.version).toBe(2);
  });

  it('throws OccVersionMismatchError with currentVersion when ifMatch is stale', async () => {
    await tracker.create(baseInput('occ-3'));
    await tracker.update('occ-3', { title: 'bumped to 2' });
    // current version is now 2; ifMatch=1 is stale.
    let caught: unknown = null;
    try {
      await tracker.update('occ-3', { title: 'should fail', ifMatch: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OccVersionMismatchError);
    expect((caught as OccVersionMismatchError).currentVersion).toBe(2);
  });

  it('succeeds when ifMatch equals current version', async () => {
    await tracker.create(baseInput('occ-4'));
    const out = await tracker.update('occ-4', { title: 'ok', ifMatch: 1 });
    expect(out.version).toBe(2);
  });

  it('succeeds when ifMatch is omitted (backward compatibility)', async () => {
    await tracker.create(baseInput('occ-5'));
    await tracker.update('occ-5', { title: 'no guard' });
    const out = await tracker.update('occ-5', { title: 'still no guard' });
    expect(out.version).toBe(3);
  });
});

// ─── Serialization round-trip ──────────────────────────────────────────────

describe('serialization (Phase 1.1)', () => {
  it('round-trip: load + save with no mutation is byte-identical', async () => {
    await tracker.create(baseInput('rt-1'));
    await tracker.create({
      ...baseInput('rt-2'),
      kind: 'project',
      rounds: [{ name: 'r1', itemIds: ['rt-1'], status: 'pending' }],
    });
    const first = readFileRaw();

    // Reload with a new tracker instance. The backfill path is a no-op
    // (records already have kind). The new tracker should not rewrite.
    const t2 = new InitiativeTracker(tmpDir);
    const afterLoad = readFileRaw();
    expect(afterLoad).toBe(first);

    // Touch read-only API; still byte-identical.
    t2.list();
    expect(readFileRaw()).toBe(first);
  });

  it('omits undefined-valued optional fields on write', async () => {
    await tracker.create(baseInput('omit-1'));
    const raw = readFileRaw();
    // None of the project-only fields should appear because they're undefined.
    expect(raw).not.toContain('"rounds"');
    expect(raw).not.toContain('"sourceDocs"');
    expect(raw).not.toContain('"telegramTopicId"');
  });
});

// ─── Status enum extension ─────────────────────────────────────────────────

describe('status enum extension (Phase 1.1)', () => {
  it('accepts "paused"', async () => {
    await tracker.create(baseInput('s-paused'));
    const out = await tracker.update('s-paused', { status: 'paused' });
    expect(out.status).toBe('paused');
  });

  it('accepts "halted"', async () => {
    await tracker.create(baseInput('s-halted'));
    const out = await tracker.update('s-halted', { status: 'halted' });
    expect(out.status).toBe('halted');
  });

  it('accepts "awaiting-user"', async () => {
    await tracker.create(baseInput('s-awaiting'));
    const out = await tracker.update('s-awaiting', { status: 'awaiting-user' });
    expect(out.status).toBe('awaiting-user');
  });
});

// ─── Digest cache invalidator hook ─────────────────────────────────────────

describe('digest cache invalidator (Phase 1.1)', () => {
  it('fires once per successful mutation', async () => {
    let calls = 0;
    tracker.setDigestCacheInvalidator(() => {
      calls++;
    });

    await tracker.create(baseInput('inv-1'));
    expect(calls).toBe(1);

    await tracker.update('inv-1', { title: 'updated' });
    expect(calls).toBe(2);

    await tracker.setPhaseStatus('inv-1', 'plan', 'in-progress');
    expect(calls).toBe(3);

    await tracker.remove('inv-1');
    expect(calls).toBe(4);
  });

  it('default invalidator is a no-op (safe when not wired)', async () => {
    // No setDigestCacheInvalidator call — mutations must still succeed.
    await tracker.create(baseInput('inv-2'));
    await tracker.update('inv-2', { title: 'updated' });
    expect(tracker.get('inv-2')!.title).toBe('updated');
  });

  it('replacing the invalidator with a non-function falls back to no-op', async () => {
    tracker.setDigestCacheInvalidator(undefined as unknown as () => void);
    // Must not throw.
    await tracker.create(baseInput('inv-3'));
    expect(tracker.get('inv-3')).toBeDefined();
  });
});

// ─── backfillKindAndSchema (public helper) ─────────────────────────────────

describe('backfillKindAndSchema()', () => {
  it('legacy-JSON path: idempotent (second call is no-op)', async () => {
    writeLegacyRecords([
      {
        id: 'bf-1',
        title: 'BF 1',
        description: 'pre-project-scope',
        status: 'active',
        phases: [{ id: 'p1', name: 'P1', status: 'pending' }],
        currentPhaseIndex: 0,
        lastTouchedAt: '2025-01-01T00:00:00.000Z',
        needsUser: false,
        blockers: [],
        links: [],
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ]);
    // Load triggers backfill via loadFromDisk; backfillKindAndSchema should now be a no-op.
    const t = new InitiativeTracker(tmpDir);
    const first = await t.backfillKindAndSchema();
    expect(first.backfilled).toBe(0); // already done by load
    const second = await t.backfillKindAndSchema();
    expect(second.backfilled).toBe(0);
  });
});
