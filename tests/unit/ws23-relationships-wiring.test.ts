/**
 * Wiring-integrity tests for WS2.3 (cross-machine relationship replication — the
 * FIRST PII kind). Two layers:
 *
 *  1. SOURCE assertions — the dual registry carries relationship-record in BOTH
 *     halves; server.ts registers RELATIONSHIP_KIND_REGISTRATION, builds the
 *     relationships union reader, and injects the peer-read seam into the manager;
 *     ConfigDefaults ships the dark default; the One Memory awareness section
 *     mentions the WS2.3 PII consumer. A feature whose wiring is silently dropped
 *     would pass a unit test but fail HERE.
 *  2. FUNCTIONAL registration — the registry accepts the relationship-record kind
 *     and resolves it by store, and getByStore('relationships') returns the kind for
 *     the rollback-unmerge contributing-kind seam.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  RELATIONSHIP_KIND_REGISTRATION,
  RELATIONSHIP_RECORD_KIND,
  RELATIONSHIP_STORE_KEY,
} from '../../src/core/RelationshipsReplicatedStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('WS2.3 dual-registry coupling', () => {
  it('relationship-record is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(RELATIONSHIP_RECORD_KIND);
  });
  it('relationship-record has a DEFAULT_RETENTION entry that is NEVER rotateKeep:0 (PII compliance)', () => {
    const r = DEFAULT_RETENTION[RELATIONSHIP_RECORD_KIND as keyof typeof DEFAULT_RETENTION];
    expect(r).toBeTruthy();
    expect(r.rotateKeep).toBeGreaterThan(0);
  });
  it('the registry accepts the registration + resolves it by kind AND store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(RELATIONSHIP_KIND_REGISTRATION);
    expect(registry.isReplicatedKind(RELATIONSHIP_RECORD_KIND)).toBe(true);
    expect(registry.getByStore(RELATIONSHIP_STORE_KEY)?.kind).toBe(RELATIONSHIP_RECORD_KIND);
  });
});

describe('WS2.3 server.ts wiring (source touchpoints)', () => {
  const serverSrc = read('src/commands/server.ts');

  it('registers RELATIONSHIP_KIND_REGISTRATION onto the shared registry', () => {
    expect(serverSrc).toContain('RELATIONSHIP_KIND_REGISTRATION');
    expect(serverSrc).toContain('replicatedKindRegistry.register(RELATIONSHIP_KIND_REGISTRATION)');
  });

  it('builds the relationships union reader through ReplicatedStoreReader', () => {
    expect(serverSrc).toContain('relationshipsUnionReader');
    expect(serverSrc).toContain('relationshipTierOf');
    expect(serverSrc).toContain('relationshipToOriginRecord');
    expect(serverSrc).toContain('deriveRelationshipRecordKey');
  });

  it('injects the peer-read seam into the manager (REQ-M7) routed THROUGH the union reader', () => {
    expect(serverSrc).toContain('setPeerReadSeam');
    expect(serverSrc).toContain('relationshipsUnionReader.read(RELATIONSHIP_STORE_KEY');
    expect(serverSrc).toContain('renderForeignRelationshipContext');
  });
});

describe('WS2.3 ConfigDefaults + awareness', () => {
  it('ConfigDefaults ships the relationships stateSync dark default (enabled:false, dryRun:true)', () => {
    const defaultsSrc = read('src/config/ConfigDefaults.ts');
    // The relationships sub-block follows the preferences sibling under stateSync.
    expect(defaultsSrc).toMatch(/relationships:\s*\{\s*\n\s*enabled:\s*false,\s*\n\s*dryRun:\s*true,/);
  });

  it('the dev-gate dark exclusion classifies the relationships path', () => {
    const devGated = read('src/core/devGatedFeatures.ts');
    expect(devGated).toContain("configPath: 'multiMachine.stateSync.relationships.enabled'");
  });

  it('the One Memory awareness section names the WS2.3 PII consumer in BOTH the template and migrator', () => {
    expect(read('src/scaffold/templates.ts')).toContain('Relationships are the FIRST PII store');
    expect(read('src/core/PostUpdateMigrator.ts')).toContain('Relationships are the FIRST PII store');
  });
});
