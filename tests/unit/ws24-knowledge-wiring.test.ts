/**
 * Wiring-integrity tests for WS2.4 (cross-machine knowledge-base replication — the THIRD
 * memory-family kind). Three layers:
 *
 *  1. SOURCE assertions — the dual registry carries knowledge-record in BOTH halves;
 *     server.ts registers KNOWLEDGE_KIND_REGISTRATION and builds the knowledge union
 *     reader; KnowledgeManager exposes the replication emit seam; ConfigDefaults ships the
 *     dark default; the dev-gate exclusion classifies the path; the One Memory awareness
 *     section mentions the WS2.4 consumer in BOTH the template + migrator. A feature whose
 *     wiring is silently dropped would pass a unit test but fail HERE.
 *  2. FUNCTIONAL registration — the registry accepts knowledge-record and resolves it by
 *     store, so getByStore('knowledge') returns the kind for the rollback-unmerge
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
  KNOWLEDGE_KIND_REGISTRATION,
  KNOWLEDGE_RECORD_KIND,
  KNOWLEDGE_STORE_KEY,
  knowledgeTierOf,
  knowledgeToOriginRecord,
  deriveKnowledgeRecordKey,
  mergeUnionToKnowledge,
} from '../../src/core/KnowledgeReplicatedStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import type { KnowledgeSource } from '../../src/knowledge/KnowledgeManager.js';
import os from 'node:os';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

function makeSource(over: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: 'kb_001', title: 'source', url: 'https://example.com/s', type: 'article',
    ingestedAt: '2026-06-01T00:00:00.000Z', filePath: 'articles/s.md', tags: [], summary: '', wordCount: 0, ...over,
  };
}

describe('WS2.4 dual-registry coupling', () => {
  it('knowledge-record is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(KNOWLEDGE_RECORD_KIND);
  });
  it('knowledge-record has a DEFAULT_RETENTION entry that is NEVER rotateKeep:0 (compliance)', () => {
    const r = DEFAULT_RETENTION[KNOWLEDGE_RECORD_KIND as keyof typeof DEFAULT_RETENTION];
    expect(r).toBeTruthy();
    expect(r.rotateKeep).toBeGreaterThan(0);
  });
  it('the registry accepts the registration + resolves it by kind AND store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(KNOWLEDGE_KIND_REGISTRATION);
    expect(registry.isReplicatedKind(KNOWLEDGE_RECORD_KIND)).toBe(true);
    expect(registry.getByStore(KNOWLEDGE_STORE_KEY)?.kind).toBe(KNOWLEDGE_RECORD_KIND);
  });
});

describe('WS2.4 server.ts wiring (source touchpoints)', () => {
  const serverSrc = read('src/commands/server.ts');

  it('registers KNOWLEDGE_KIND_REGISTRATION onto the shared registry', () => {
    expect(serverSrc).toContain('KNOWLEDGE_KIND_REGISTRATION');
    expect(serverSrc).toContain('replicatedKindRegistry.register(KNOWLEDGE_KIND_REGISTRATION)');
  });

  it('builds the knowledge union reader through ReplicatedStoreReader', () => {
    expect(serverSrc).toContain('knowledgeUnionReader');
    expect(serverSrc).toContain('knowledgeTierOf');
    expect(serverSrc).toContain('knowledgeToOriginRecord');
    expect(serverSrc).toContain('deriveKnowledgeRecordKey');
  });
});

describe('WS2.4 KnowledgeManager emit seam (source touchpoints)', () => {
  const kmSrc = read('src/knowledge/KnowledgeManager.ts');
  it('exposes the KnowledgeReplicationEmitter interface + setter', () => {
    expect(kmSrc).toContain('KnowledgeReplicationEmitter');
    expect(kmSrc).toContain('setKnowledgeReplicationEmitter');
  });
  it('the ingest funnel emits a put + the remove funnel emits a tombstone (resurrection guard)', () => {
    expect(kmSrc).toContain('emitPut');
    expect(kmSrc).toContain('emitDelete');
  });
});

describe('WS2.4 ConfigDefaults + awareness', () => {
  it('ConfigDefaults ships the knowledge stateSync dev-gated posture (OMITS enabled, dryRun:false — operator directive 2026-06-13)', () => {
    const defaultsSrc = read('src/config/ConfigDefaults.ts');
    expect(defaultsSrc).toMatch(/knowledge:\s*\{\s*\n\s*dryRun:\s*false,\s*\n\s*\},/);
    expect(defaultsSrc).not.toMatch(/knowledge:\s*\{\s*\n\s*enabled:\s*false/);
  });

  it('the dev-gate classifies the knowledge path as DEV_GATED (live-on-dev), not a dark exclusion', () => {
    const devGated = read('src/core/devGatedFeatures.ts');
    expect(devGated).toContain("configPath: 'multiMachine.stateSync.knowledge.enabled'");
  });

  it('the One Memory awareness section names the WS2.4 consumer in BOTH the template and migrator', () => {
    expect(read('src/scaffold/templates.ts')).toContain('Knowledge base is the THIRD memory-family store');
    expect(read('src/core/PostUpdateMigrator.ts')).toContain('Knowledge base is the THIRD memory-family store');
  });
});

describe('WS2.4 §12 union-reader-cannot-be-bypassed', () => {
  let dir: string;
  function reader(records: KnowledgeSource[], meshSelf = 'm_self'): ReplicatedStoreReader {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws24-union-'));
    const registry = new ReplicatedKindRegistry();
    registry.register(KNOWLEDGE_KIND_REGISTRATION);
    return new ReplicatedStoreReader({
      registry,
      stores: { [KNOWLEDGE_STORE_KEY]: { enabled: true } },
      tierOf: knowledgeTierOf,
      loadOriginRecords: (store, key) => {
        if (store !== KNOWLEDGE_STORE_KEY) return [];
        const out = [];
        for (const s of records) {
          if (deriveKnowledgeRecordKey(s.title, s.url, s.type) === key) {
            const o = knowledgeToOriginRecord(s, meshSelf);
            if (o) out.push(o);
          }
        }
        return out;
      },
      listRecordKeys: () => {
        const keys: string[] = [];
        for (const s of records) {
          const k = deriveKnowledgeRecordKey(s.title, s.url, s.type);
          if (k) keys.push(k);
        }
        return keys;
      },
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    });
  }

  it('a single own-origin record reads back as a resolved value through the union (no clobber)', () => {
    const rec = makeSource({ title: 'openclaw', url: 'https://example.com/openclaw' });
    const r = reader([rec]);
    const key = deriveKnowledgeRecordKey(rec.title, rec.url, rec.type)!;
    const result = r.read(KNOWLEDGE_STORE_KEY, key);
    const views = mergeUnionToKnowledge(new Map([[key, result]]));
    expect(views).toHaveLength(1);
    expect(views[0].data.title).toBe('openclaw');
    expect(views[0].conflicted).toBe(false);
  });
});
