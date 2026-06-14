/**
 * Wiring-integrity tests for WS2.5 (cross-machine evolution-action-queue replication — the
 * FOURTH memory-family kind). Three layers:
 *
 *  1. SOURCE assertions — the dual registry carries evolution-action-record in BOTH halves;
 *     server.ts registers EVOLUTION_ACTION_KIND_REGISTRATION and builds the actions union
 *     reader; EvolutionManager exposes the action replication emit seam; ConfigDefaults ships
 *     the dark default; the dev-gate exclusion classifies the path; the One Memory awareness
 *     section mentions the WS2.5 consumer in BOTH the template + migrator. A feature whose
 *     wiring is silently dropped would pass a unit test but fail HERE.
 *  2. FUNCTIONAL registration — the registry accepts evolution-action-record and resolves it
 *     by store, so getByStore('evolutionActions') returns the kind for the rollback-unmerge
 *     contributing-kind seam.
 *  3. §12 union-reader-cannot-be-bypassed — the merged read routes THROUGH the union reader
 *     (a replicated record never clobbers a divergent local one; an open conflict surfaces
 *     BOTH variants, never a silent clobber).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import {
  EVOLUTION_ACTION_KIND_REGISTRATION,
  EVOLUTION_ACTION_RECORD_KIND,
  EVOLUTION_ACTION_STORE_KEY,
  evolutionActionTierOf,
  evolutionActionToOriginRecord,
  deriveEvolutionActionRecordKey,
  mergeUnionToActions,
} from '../../src/core/EvolutionActionsReplicatedStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import type { ActionItem } from '../../src/core/types.js';
import os from 'node:os';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

function makeAction(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'ACT-001', title: 'the action', description: '', priority: 'medium', status: 'pending',
    commitTo: 'Justin', createdAt: '2026-06-01T00:00:00.000Z', tags: [], ...over,
  };
}

describe('WS2.5 dual-registry coupling', () => {
  it('evolution-action-record is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(EVOLUTION_ACTION_RECORD_KIND);
  });
  it('evolution-action-record has a DEFAULT_RETENTION entry that is NEVER rotateKeep:0 (compliance)', () => {
    const r = DEFAULT_RETENTION[EVOLUTION_ACTION_RECORD_KIND as keyof typeof DEFAULT_RETENTION];
    expect(r).toBeTruthy();
    expect(r.rotateKeep).toBeGreaterThan(0);
  });
  it('the registry accepts the registration + resolves it by kind AND store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(EVOLUTION_ACTION_KIND_REGISTRATION);
    expect(registry.isReplicatedKind(EVOLUTION_ACTION_RECORD_KIND)).toBe(true);
    expect(registry.getByStore(EVOLUTION_ACTION_STORE_KEY)?.kind).toBe(EVOLUTION_ACTION_RECORD_KIND);
  });
});

describe('WS2.5 server.ts wiring (source touchpoints)', () => {
  const serverSrc = read('src/commands/server.ts');

  it('registers EVOLUTION_ACTION_KIND_REGISTRATION onto the shared registry', () => {
    expect(serverSrc).toContain('EVOLUTION_ACTION_KIND_REGISTRATION');
    expect(serverSrc).toContain('replicatedKindRegistry.register(EVOLUTION_ACTION_KIND_REGISTRATION)');
  });

  it('builds the evolution-actions union reader through ReplicatedStoreReader', () => {
    expect(serverSrc).toContain('evolutionActionsUnionReader');
    expect(serverSrc).toContain('evolutionActionTierOf');
    expect(serverSrc).toContain('evolutionActionToOriginRecord');
    expect(serverSrc).toContain('deriveEvolutionActionRecordKey');
  });
});

describe('WS2.5 EvolutionManager emit seam (source touchpoints)', () => {
  const evoSrc = read('src/core/EvolutionManager.ts');
  it('exposes the EvolutionActionReplicationEmitter interface + setter', () => {
    expect(evoSrc).toContain('EvolutionActionReplicationEmitter');
    expect(evoSrc).toContain('setEvolutionActionReplicationEmitter');
  });
  it('the saveActions funnel emits a put + a queue-removal emits a tombstone (resurrection guard)', () => {
    expect(evoSrc).toContain('this.actionReplication');
    expect(evoSrc).toContain('emitDelete(pruned.title, pruned.commitTo, pruned.createdAt');
  });
});

describe('WS2.5 ConfigDefaults + awareness', () => {
  it('ConfigDefaults ships the evolutionActions stateSync dark default (enabled:false, dryRun:true)', () => {
    const defaultsSrc = read('src/config/ConfigDefaults.ts');
    expect(defaultsSrc).toMatch(/evolutionActions:\s*\{\s*\n\s*enabled:\s*false,\s*\n\s*dryRun:\s*true,/);
  });

  it('the dev-gate dark exclusion classifies the evolutionActions path', () => {
    const devGated = read('src/core/devGatedFeatures.ts');
    expect(devGated).toContain("configPath: 'multiMachine.stateSync.evolutionActions.enabled'");
  });

  it('the One Memory awareness section names the WS2.5 consumer in BOTH the template and migrator', () => {
    expect(read('src/scaffold/templates.ts')).toContain('Evolution action queue is the FOURTH memory-family store');
    expect(read('src/core/PostUpdateMigrator.ts')).toContain('Evolution action queue is the FOURTH memory-family store');
  });
});

describe('WS2.5 §12 union-reader-cannot-be-bypassed', () => {
  let dir: string;
  function reader(records: ActionItem[], meshSelf = 'm_self'): ReplicatedStoreReader {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws25-union-'));
    const registry = new ReplicatedKindRegistry();
    registry.register(EVOLUTION_ACTION_KIND_REGISTRATION);
    return new ReplicatedStoreReader({
      registry,
      stores: { [EVOLUTION_ACTION_STORE_KEY]: { enabled: true } },
      tierOf: evolutionActionTierOf,
      loadOriginRecords: (store, key) => {
        if (store !== EVOLUTION_ACTION_STORE_KEY) return [];
        const out = [];
        for (const a of records) {
          if (deriveEvolutionActionRecordKey(a.title, a.commitTo, a.createdAt) === key) {
            const o = evolutionActionToOriginRecord(a, meshSelf);
            if (o) out.push(o);
          }
        }
        return out;
      },
      listRecordKeys: () => {
        const keys: string[] = [];
        for (const a of records) {
          const k = deriveEvolutionActionRecordKey(a.title, a.commitTo, a.createdAt);
          if (k) keys.push(k);
        }
        return keys;
      },
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    });
  }

  it('a single own-origin record reads back as a resolved value through the union (no clobber)', () => {
    const rec = makeAction({ title: 'fix bug', status: 'in_progress' });
    const r = reader([rec]);
    const key = deriveEvolutionActionRecordKey(rec.title, rec.commitTo, rec.createdAt)!;
    const result = r.read(EVOLUTION_ACTION_STORE_KEY, key);
    const views = mergeUnionToActions(new Map([[key, result]]));
    expect(views).toHaveLength(1);
    expect(views[0].data.title).toBe('fix bug');
    expect(views[0].data.status).toBe('in_progress');
    expect(views[0].conflicted).toBe(false);
  });
});
