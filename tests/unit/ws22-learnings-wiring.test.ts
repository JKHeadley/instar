/**
 * Wiring-integrity tests for WS2.2 (cross-machine learning replication — the SECOND
 * memory-family kind). Three layers:
 *
 *  1. SOURCE assertions — the dual registry carries learning-record in BOTH halves;
 *     server.ts registers LEARNING_KIND_REGISTRATION and builds the learnings union
 *     reader; EvolutionManager exposes the replication emit seam; ConfigDefaults ships
 *     the dark default; the dev-gate exclusion classifies the path; the One Memory
 *     awareness section mentions the WS2.2 consumer in BOTH the template + migrator. A
 *     feature whose wiring is silently dropped would pass a unit test but fail HERE.
 *  2. FUNCTIONAL registration — the registry accepts learning-record and resolves it by
 *     store, so getByStore('learnings') returns the kind for the rollback-unmerge
 *     contributing-kind seam.
 *  3. §12 union-reader-cannot-be-bypassed — the merged read routes THROUGH the union
 *     reader (a replicated record never clobbers a divergent local one; an open conflict
 *     surfaces BOTH variants, never a silent clobber).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import {
  LEARNING_KIND_REGISTRATION,
  LEARNING_RECORD_KIND,
  LEARNING_STORE_KEY,
  learningTierOf,
  learningToOriginRecord,
  deriveLearningRecordKey,
  mergeUnionToLearnings,
} from '../../src/core/LearningsReplicatedStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import type { LearningEntry } from '../../src/core/types.js';
import os from 'node:os';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

function makeLearning(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: 'LRN-001', title: 'lesson', category: 'infra', description: 'd',
    source: { discoveredAt: '2026-06-01T00:00:00.000Z' }, tags: [], applied: false, ...over,
  };
}

describe('WS2.2 dual-registry coupling', () => {
  it('learning-record is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(LEARNING_RECORD_KIND);
  });
  it('learning-record has a DEFAULT_RETENTION entry that is NEVER rotateKeep:0 (compliance)', () => {
    const r = DEFAULT_RETENTION[LEARNING_RECORD_KIND as keyof typeof DEFAULT_RETENTION];
    expect(r).toBeTruthy();
    expect(r.rotateKeep).toBeGreaterThan(0);
  });
  it('the registry accepts the registration + resolves it by kind AND store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    expect(registry.isReplicatedKind(LEARNING_RECORD_KIND)).toBe(true);
    expect(registry.getByStore(LEARNING_STORE_KEY)?.kind).toBe(LEARNING_RECORD_KIND);
  });
});

describe('WS2.2 server.ts wiring (source touchpoints)', () => {
  const serverSrc = read('src/commands/server.ts');

  it('registers LEARNING_KIND_REGISTRATION onto the shared registry', () => {
    expect(serverSrc).toContain('LEARNING_KIND_REGISTRATION');
    expect(serverSrc).toContain('replicatedKindRegistry.register(LEARNING_KIND_REGISTRATION)');
  });

  it('builds the learnings union reader through ReplicatedStoreReader', () => {
    expect(serverSrc).toContain('learningsUnionReader');
    expect(serverSrc).toContain('learningTierOf');
    expect(serverSrc).toContain('learningToOriginRecord');
    expect(serverSrc).toContain('deriveLearningRecordKey');
  });
});

describe('WS2.2 EvolutionManager emit seam (source touchpoints)', () => {
  const evoSrc = read('src/core/EvolutionManager.ts');
  it('exposes the LearningReplicationEmitter interface + setter', () => {
    expect(evoSrc).toContain('LearningReplicationEmitter');
    expect(evoSrc).toContain('setLearningReplicationEmitter');
  });
  it('the saveLearnings funnel emits a tombstone for PRUNED learnings (resurrection guard)', () => {
    // The prune path must emit op:delete for pruned learnings — assert the funnel
    // references emitDelete in the save path (the named §3 gate).
    expect(evoSrc).toContain('emitDelete');
    expect(evoSrc).toContain('emitPut');
  });
});

describe('WS2.2 ConfigDefaults + awareness', () => {
  it('ConfigDefaults ships the learnings stateSync dark default (enabled:false, dryRun:true)', () => {
    const defaultsSrc = read('src/config/ConfigDefaults.ts');
    expect(defaultsSrc).toMatch(/learnings:\s*\{\s*\n\s*enabled:\s*false,\s*\n\s*dryRun:\s*true,/);
  });

  it('the dev-gate dark exclusion classifies the learnings path', () => {
    const devGated = read('src/core/devGatedFeatures.ts');
    expect(devGated).toContain("configPath: 'multiMachine.stateSync.learnings.enabled'");
  });

  it('the One Memory awareness section names the WS2.2 consumer in BOTH the template and migrator', () => {
    expect(read('src/scaffold/templates.ts')).toContain('Learnings are the SECOND memory-family store');
    expect(read('src/core/PostUpdateMigrator.ts')).toContain('Learnings are the SECOND memory-family store');
  });
});

describe('WS2.2 §12 union-reader-cannot-be-bypassed', () => {
  let dir: string;
  function reader(records: LearningEntry[], meshSelf = 'm_self'): ReplicatedStoreReader {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws22-union-'));
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    return new ReplicatedStoreReader({
      registry,
      stores: { [LEARNING_STORE_KEY]: { enabled: true } },
      tierOf: learningTierOf,
      loadOriginRecords: (store, key) => {
        if (store !== LEARNING_STORE_KEY) return [];
        const out = [];
        for (const l of records) {
          if (deriveLearningRecordKey(l.title, l.category, l.source) === key) {
            const o = learningToOriginRecord(l, meshSelf);
            if (o) out.push(o);
          }
        }
        return out;
      },
      listRecordKeys: () => {
        const keys: string[] = [];
        for (const l of records) {
          const k = deriveLearningRecordKey(l.title, l.category, l.source);
          if (k) keys.push(k);
        }
        return keys;
      },
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    });
  }

  it('a single own-origin record reads back as a resolved value through the union (no clobber)', () => {
    const rec = makeLearning({ title: 'tmux colon' });
    const r = reader([rec]);
    const key = deriveLearningRecordKey(rec.title, rec.category, rec.source)!;
    const result = r.read(LEARNING_STORE_KEY, key);
    const views = mergeUnionToLearnings(new Map([[key, result]]));
    expect(views).toHaveLength(1);
    expect(views[0].data.title).toBe('tmux colon');
    expect(views[0].conflicted).toBe(false);
  });
});
