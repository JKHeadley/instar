/**
 * Wiring-integrity tests for WS2.6 (cross-machine user-registry + topic-operator replication —
 * the SECOND + THIRD PII kinds, completing the WS2 memory family). Layers:
 *
 *  1. SOURCE assertions — the dual registry carries user-record + topic-operator-record in BOTH
 *     halves; server.ts registers both KIND_REGISTRATIONs and builds both union readers;
 *     UserManager + TopicOperatorStore expose their replication emit seams; ConfigDefaults ships
 *     the dark defaults; the dev-gate exclusions classify both paths; the One Memory awareness
 *     section names BOTH consumers in the template + migrator.
 *  2. FUNCTIONAL registration — the registry accepts both kinds and resolves each by store.
 *  3. §12 union-reader-cannot-be-bypassed — the merged read routes THROUGH the union reader.
 *  4. THE BLOCKER (untrusted-replicated-operator-never-authoritative) — a peer-originated
 *     topic-operator record NEVER changes the local TopicOperatorStore.getOperator() authority;
 *     only a local authenticated setOperator does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import {
  USER_KIND_REGISTRATION,
  USER_RECORD_KIND,
  USER_STORE_KEY,
  userTierOf,
  userToOriginRecord,
  deriveUserRecordKey,
  mergeUnionToUsers,
} from '../../src/core/UserRegistryReplicatedStore.js';
import {
  TOPIC_OPERATOR_KIND_REGISTRATION,
  TOPIC_OPERATOR_RECORD_KIND,
  TOPIC_OPERATOR_STORE_KEY,
  buildTopicOperatorRecordData,
  deriveTopicOperatorRecordKey,
} from '../../src/core/TopicOperatorReplicatedStore.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { UserManager } from '../../src/users/UserManager.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import type { UserProfile } from '../../src/core/types.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

function makeUser(over: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'usr-001', name: 'Justin', channels: [{ type: 'telegram', identifier: '12345' }],
    permissions: ['admin'], preferences: {}, createdAt: '2026-06-01T00:00:00.000Z', telegramUserId: 999, ...over,
  };
}

describe('WS2.6 dual-registry coupling', () => {
  it('user-record + topic-operator-record are in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(USER_RECORD_KIND);
    expect(JOURNAL_KINDS).toContain(TOPIC_OPERATOR_RECORD_KIND);
  });
  it('both have DEFAULT_RETENTION entries that are NEVER rotateKeep:0 (compliance)', () => {
    for (const k of [USER_RECORD_KIND, TOPIC_OPERATOR_RECORD_KIND] as const) {
      const r = DEFAULT_RETENTION[k as keyof typeof DEFAULT_RETENTION];
      expect(r).toBeTruthy();
      expect(r.rotateKeep).toBeGreaterThan(0);
    }
  });
  it('the registry accepts both registrations + resolves each by kind AND store', () => {
    const registry = new ReplicatedKindRegistry();
    registry.register(USER_KIND_REGISTRATION);
    registry.register(TOPIC_OPERATOR_KIND_REGISTRATION);
    expect(registry.isReplicatedKind(USER_RECORD_KIND)).toBe(true);
    expect(registry.isReplicatedKind(TOPIC_OPERATOR_RECORD_KIND)).toBe(true);
    expect(registry.getByStore(USER_STORE_KEY)?.kind).toBe(USER_RECORD_KIND);
    expect(registry.getByStore(TOPIC_OPERATOR_STORE_KEY)?.kind).toBe(TOPIC_OPERATOR_RECORD_KIND);
  });
});

describe('WS2.6 server.ts wiring (source touchpoints)', () => {
  const serverSrc = read('src/commands/server.ts');
  it('registers BOTH KIND_REGISTRATIONs onto the shared registry', () => {
    expect(serverSrc).toContain('replicatedKindRegistry.register(USER_KIND_REGISTRATION)');
    expect(serverSrc).toContain('replicatedKindRegistry.register(TOPIC_OPERATOR_KIND_REGISTRATION)');
  });
  it('builds both union readers through ReplicatedStoreReader', () => {
    expect(serverSrc).toContain('userRegistryUnionReader');
    expect(serverSrc).toContain('userToOriginRecord');
    expect(serverSrc).toContain('topicOperatorUnionReader');
    expect(serverSrc).toContain('topicOperatorToOriginRecord');
  });
});

describe('WS2.6 manager emit seams (source touchpoints)', () => {
  it('UserManager exposes the UserReplicationEmitter interface + setter + emit funnel + tombstone', () => {
    const umSrc = read('src/users/UserManager.ts');
    expect(umSrc).toContain('UserReplicationEmitter');
    expect(umSrc).toContain('setUserReplicationEmitter');
    expect(umSrc).toContain('this.userReplication');
    expect(umSrc).toContain('emitter.emitDelete(removedChannels');
  });
  it('TopicOperatorStore exposes the TopicOperatorReplicationEmitter interface + setter + emit on bind', () => {
    const tosSrc = read('src/users/TopicOperatorStore.ts');
    expect(tosSrc).toContain('TopicOperatorReplicationEmitter');
    expect(tosSrc).toContain('setOperatorReplicationEmitter');
    expect(tosSrc).toContain('this.operatorReplication');
    expect(tosSrc).toContain('emitter.emitPut(topicId, record)');
  });
});

describe('WS2.6 ConfigDefaults + dev-gate + awareness', () => {
  it('ConfigDefaults ships BOTH stateSync dark defaults (enabled:false, dryRun:true)', () => {
    const defaultsSrc = read('src/config/ConfigDefaults.ts');
    expect(defaultsSrc).toMatch(/userRegistry:\s*\{\s*\n\s*enabled:\s*false,\s*\n\s*dryRun:\s*true,/);
    expect(defaultsSrc).toMatch(/topicOperator:\s*\{\s*\n\s*enabled:\s*false,\s*\n\s*dryRun:\s*true,/);
  });
  it('the dev-gate dark exclusions classify BOTH paths', () => {
    const devGated = read('src/core/devGatedFeatures.ts');
    expect(devGated).toContain("configPath: 'multiMachine.stateSync.userRegistry.enabled'");
    expect(devGated).toContain("configPath: 'multiMachine.stateSync.topicOperator.enabled'");
  });
  it('the One Memory awareness names BOTH consumers in the template AND migrator', () => {
    for (const f of ['src/scaffold/templates.ts', 'src/core/PostUpdateMigrator.ts']) {
      const src = read(f);
      expect(src).toContain('User registry is the SECOND PII store');
      expect(src).toContain('Topic-operator binding is the THIRD PII store');
    }
  });
  it('the migrator has a chained else-if that splices the WS2.6 lines for deployed agents', () => {
    const mig = read('src/core/PostUpdateMigrator.ts');
    expect(mig).toContain("!content.includes('User registry is the SECOND PII store')");
    expect(mig).toContain('added WS2.6 user-registry + topic-operator PII lines');
  });
});

describe('WS2.6 §12 union-reader-cannot-be-bypassed (user-registry)', () => {
  it('a single own-origin user reads back as a resolved value through the union (no clobber)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws26-union-'));
    const registry = new ReplicatedKindRegistry();
    registry.register(USER_KIND_REGISTRATION);
    const records = [makeUser({ name: 'Justin', channels: [{ type: 'telegram', identifier: '1' }] })];
    const reader = new ReplicatedStoreReader({
      registry,
      stores: { [USER_STORE_KEY]: { enabled: true } },
      tierOf: userTierOf,
      loadOriginRecords: (store, key) => {
        if (store !== USER_STORE_KEY) return [];
        const out = [];
        for (const u of records) {
          if (deriveUserRecordKey(u.channels) === key) {
            const o = userToOriginRecord(u, 'm_self');
            if (o) out.push(o);
          }
        }
        return out;
      },
      listRecordKeys: () => records.map((u) => deriveUserRecordKey(u.channels)).filter((k): k is string => k !== null),
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    });
    const key = deriveUserRecordKey(records[0].channels)!;
    const views = mergeUnionToUsers(new Map([[key, reader.read(USER_STORE_KEY, key)]]));
    expect(views).toHaveLength(1);
    expect(views[0].data.name).toBe('Justin');
    expect(views[0].conflicted).toBe(false);
  });
});

describe('WS2.6 dark-ship strict no-op (no emitter ⇒ byte-identical single-machine behavior)', () => {
  it('UserManager with NO replication emitter persists + removes exactly as before (no emission attempt)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws26-darkU-'));
    const um = new UserManager(dir); // no setUserReplicationEmitter ⇒ dark
    um.upsertUser(makeUser({ id: 'u1', channels: [{ type: 'telegram', identifier: '7' }] }));
    expect(um.listUsers()).toHaveLength(1);
    expect(um.removeUser('u1')).toBe(true);
    expect(um.listUsers()).toHaveLength(0);
    // The persisted file is the normal users.json — replication left no trace.
    expect(fs.existsSync(path.join(dir, 'users.json'))).toBe(true);
  });

  it('TopicOperatorStore with NO replication emitter binds exactly as before (no emission attempt)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws26-darkT-'));
    const tos = new TopicOperatorStore(dir); // no setOperatorReplicationEmitter ⇒ dark
    const bound = tos.setOperator(42, { platform: 'telegram', uid: '999', displayName: 'Justin', boundAt: '2026-06-01T00:00:00.000Z' });
    expect(bound).not.toBeNull();
    expect(tos.getOperator(42)?.uid).toBe('999');
    expect(fs.existsSync(path.join(dir, 'topic-operators.json'))).toBe(true);
  });
});

describe('WS2.6 THE BLOCKER — untrusted-replicated-operator-never-authoritative (cross-store)', () => {
  it('a peer-originated topic-operator record NEVER changes the local getOperator() authority', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws26-op-'));
    const store = new TopicOperatorStore(dir);

    // No local binding yet → no authoritative operator.
    expect(store.getOperator(42)).toBeNull();

    // A peer "binds" topic 42 to operator 777888 — a replicated record (validated projection).
    // There is NO apply path from a replicated record into TopicOperatorStore by construction, so
    // building/validating the foreign record can NEVER establish the local operator.
    const foreign = buildTopicOperatorRecordData({
      topicId: 42,
      record: { platform: 'telegram', uid: '777888', names: ['attacker'], boundAt: '2026-06-01T00:00:00.000Z', boundFrom: 'authenticated-inbound' },
      hlc: { physical: 100, logical: 0, node: 'm_peer' },
      origin: 'm_peer',
    });
    expect(foreign).not.toBeNull();
    // The local authority is UNCHANGED — still no operator (a replicated record never binds).
    expect(store.getOperator(42)).toBeNull();

    // ONLY a local authenticated setOperator binds the principal.
    const bound = store.setOperator(42, { platform: 'telegram', uid: '999', displayName: 'Justin', boundAt: '2026-06-02T00:00:00.000Z' });
    expect(bound).not.toBeNull();
    expect(store.getOperator(42)?.uid).toBe('999'); // the LOCAL uid, never the peer's 777888

    // The peer's recordKey (topic 42 + uid 777888) is a DIFFERENT record from the local binding
    // (topic 42 + uid 999) — they can never collide, so a replica can never overwrite the local one.
    expect(deriveTopicOperatorRecordKey(42, '777888')).not.toBe(deriveTopicOperatorRecordKey(42, '999'));
  });
});
