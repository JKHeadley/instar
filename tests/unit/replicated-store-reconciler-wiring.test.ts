// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Wiring ratchet — ReplicatedStoreReconciler (docs/specs/statesync-writer-agnostic-reconciler.md
 * "Wiring ratchet"):
 *
 *   - every store registered on the server's real ReplicatedKindRegistry (read from the
 *     `replicatedKindRegistry.register(...)` calls in src/commands/server.ts, so a new
 *     registration cannot dodge this test) is either seamed by buildReconcilerSeams or
 *     listed in RECONCILER_ALLOWLIST — never both, never neither;
 *   - deletion intents exist only on relationships + knowledge;
 *   - per seamed store, the seam's built record has the SAME fingerprint as the in-process
 *     hook builder's for the same record (same options — incl. the preference scrubber);
 *   - the reconciler's clock is the emitter's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildReconcilerSeams, RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { ReplicatedStoreReconciler, type ReconcileStoreSeam } from '../../src/core/ReplicatedStoreReconciler.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import {
  ReplicatedKindRegistry,
  validateReplicatedEnvelope,
  type ReplicatedKindRegistration,
} from '../../src/core/ReplicatedRecordEnvelope.js';
import { HybridLogicalClock, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { stableJson } from '../../src/core/stableJson.js';
import { redactForLiveTail } from '../../src/core/liveTailRedaction.js';
import { PREF_STORE_KEY, buildPrefRecordData } from '../../src/core/PreferencesReplicatedStore.js';
import type { PreferenceEntry } from '../../src/core/PreferencesManager.js';
import { RELATIONSHIP_STORE_KEY, buildRelationshipRecordData } from '../../src/core/RelationshipsReplicatedStore.js';
import { KNOWLEDGE_STORE_KEY, buildKnowledgeRecordData } from '../../src/core/KnowledgeReplicatedStore.js';
import { USER_STORE_KEY, buildUserRecordData } from '../../src/core/UserRegistryReplicatedStore.js';
import { LEARNING_STORE_KEY, buildLearningRecordData } from '../../src/core/LearningsReplicatedStore.js';
import { EVOLUTION_ACTION_STORE_KEY, buildEvolutionActionRecordData } from '../../src/core/EvolutionActionsReplicatedStore.js';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import { KnowledgeManager } from '../../src/knowledge/KnowledgeManager.js';
import type { ActionItem, LearningEntry, RelationshipRecord, UserProfile } from '../../src/core/types.js';
import type { KnowledgeSource } from '../../src/knowledge/KnowledgeManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_TS = path.join(ROOT, 'src', 'commands', 'server.ts');
const ROUTES_TS = path.join(ROOT, 'src', 'server', 'routes.ts');
const NOOP = { bumpSchemaReject: () => {}, bumpDroppedField: () => {}, bumpJailReject: () => {} };
const ORIGIN = 'm_wiring';
const H: HlcTimestamp = { physical: 1_800_000_000_000, logical: 0, node: ORIGIN };

/** The registrations server.ts puts on its real registry, resolved from source. */
async function serverRegistrations(): Promise<ReplicatedKindRegistration[]> {
  const src = fs.readFileSync(SERVER_TS, 'utf-8');
  const registered = [...src.matchAll(/replicatedKindRegistry\.register\(\s*([A-Z0-9_]+)\s*\)/g)].map((m) => m[1]);
  expect(registered.length).toBeGreaterThan(5);
  const out: ReplicatedKindRegistration[] = [];
  for (const name of registered) {
    const imp = new RegExp(`const \\{[^}]*\\b${name}\\b[^}]*\\} = await import\\('\\.\\./([^']+)\\.js'\\)`).exec(src);
    expect(imp, `server.ts registers ${name} but its import was not found`).not.toBeNull();
    const mod = await import(path.join(ROOT, 'src', `${imp![1]}.ts`));
    expect(mod[name], `${imp![1]} does not export ${name}`).toBeDefined();
    out.push(mod[name] as ReplicatedKindRegistration);
  }
  return out;
}

const dirs: string[] = [];
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `reconcile-wiring-${label}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    SafeFsExecutor.safeRmSync(dirs.pop()!, { recursive: true, force: true, operation: 'tests/unit/replicated-store-reconciler-wiring.test.ts' });
  }
});

function fp(reg: ReplicatedKindRegistration, data: Record<string, unknown> | null): string {
  expect(data).not.toBeNull();
  const v = validateReplicatedEnvelope(data, reg.schema, NOOP);
  expect(v.ok).toBe(true);
  if (!v.ok) return '';
  return createHash('sha256').update(stableJson(v.storeFields)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('coverage ratchet', () => {
  it('seamed ∪ allow-list == the server registry stores (disjoint)', async () => {
    const regs = await serverRegistrations();
    const registryStores = new Set(regs.map((r) => r.store));
    const seamed = new Set(
      buildReconcilerSeams({ stateDir: tmp('cov'), relationshipsDir: '/x/relationships', evolution: { listLearnings: () => [], listActions: () => [] } })
        .map((s) => s.store),
    );
    const allow = new Set(Object.keys(RECONCILER_ALLOWLIST));
    for (const s of seamed) expect(allow.has(s), `${s} is both seamed and allow-listed`).toBe(false);
    expect(new Set([...seamed, ...allow])).toEqual(registryStores);
    for (const [store, reason] of Object.entries(RECONCILER_ALLOWLIST)) {
      expect(reason.length, `${store} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('every seam constructs against the real registry (the reconciler validates registration)', async () => {
    const registry = new ReplicatedKindRegistry();
    for (const r of await serverRegistrations()) registry.register(r);
    const emitter = new ReplicatedRecordEmitter({
      journal: { emitReplicatedRecord: () => 'accepted' },
      clock: new HybridLogicalClock({ node: ORIGIN, now: () => Date.now() }),
      registry,
      origin: ORIGIN,
      stores: () => ({}),
      loadWitness: () => undefined,
    });
    const rec = new ReplicatedStoreReconciler({
      emitter,
      reader: { loadOwnOriginRecordsAsync: async () => new Map() },
      registry,
      origin: ORIGIN,
      stores: () => ({}),
      seams: buildReconcilerSeams({ stateDir: tmp('reg'), relationshipsDir: '/x/rel', evolution: { listLearnings: () => [], listActions: () => [] } }),
      gitCarried: async () => 'local',
      config: () => ({}),
    });
    expect(rec.seamedStores.length).toBe(6);
    expect(rec.clock).toBe(emitter.clock); // the reconciler fences against the emitter's clock
  });

  it('deletion intents (and tombstone builders) only on relationships + knowledge', () => {
    const seams = buildReconcilerSeams({ stateDir: tmp('del'), relationshipsDir: '/x/rel', evolution: { listLearnings: () => [], listActions: () => [] } });
    const withIntents = seams.filter((s) => s.deletionIntents).map((s) => s.store).sort();
    expect(withIntents).toEqual([KNOWLEDGE_STORE_KEY, RELATIONSHIP_STORE_KEY].sort());
    for (const s of seams) expect(typeof s.tombstoneFromKey === 'function').toBe(!!s.deletionIntents);
  });

  it('no relationships seam when relationshipsDir is not configured', () => {
    const seams = buildReconcilerSeams({ stateDir: tmp('norel'), evolution: { listLearnings: () => [], listActions: () => [] } });
    expect(seams.map((s) => s.store)).not.toContain(RELATIONSHIP_STORE_KEY);
  });
});

describe('the seam builds the same record as the in-process hook (per store)', () => {
  async function setup() {
    const regs = new Map((await serverRegistrations()).map((r) => [r.store, r]));
    const stateDir = tmp('fp');
    const relDir = path.join(stateDir, 'relationships');

    const pref: PreferenceEntry = {
      learning: 'Never paste api_key = "sk-ABCD1234EFGH5678IJKL" into chat.',
      provenance: 'correction-loop',
      dedupeKey: 'no-pasted-keys',
      recordedAt: '2026-10-01T00:00:00.000Z',
      confidence: 0.9,
      dedupeCount: 2,
    } as PreferenceEntry;
    fs.writeFileSync(path.join(stateDir, 'preferences.json'), JSON.stringify({ schemaVersion: 1, preferences: [pref] }));

    const rm = new RelationshipManager({ relationshipsDir: relDir, maxRecentInteractions: 20 });
    rm.findOrCreate('Ada', { type: 'telegram', identifier: '424242' });

    new KnowledgeManager(stateDir).ingest('body', { title: 'EXO', url: 'https://example.com/exo', type: 'article', tags: ['x'] });

    const user = { id: 'u1', name: 'Justin', channels: [{ type: 'telegram', identifier: '1' }], permissions: ['admin'], preferences: {}, createdAt: '2026-10-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([user]));

    const learning = {
      id: 'LRN-001', title: 'Use trailing colon', category: 'ops', description: 'tmux targets', tags: ['tmux'], applied: false,
      source: { discoveredAt: '2026-10-01T00:00:00.000Z' },
    } as unknown as LearningEntry;
    const action = {
      id: 'ACT-001', title: 'Ship it', description: 'd', priority: 'high', status: 'pending', commitTo: 'Justin', createdAt: '2026-10-01T00:00:00.000Z',
    } as unknown as ActionItem;

    const seams = new Map<string, ReconcileStoreSeam>(
      buildReconcilerSeams({ stateDir, relationshipsDir: relDir, evolution: { listLearnings: () => [learning], listActions: () => [action] } })
        .map((s) => [s.store, s]),
    );
    return { regs, seams, stateDir, relDir, pref, user, learning, action };
  }

  function onlyRow(seam: ReconcileStoreSeam) {
    const snap = seam.snapshot();
    expect(snap.present).toBe(true);
    expect(snap.skipped).toBe(0);
    expect(snap.rows).toHaveLength(1);
    return snap.rows[0];
  }

  it('preferences: seam and hook both pass the scrubber (and the fingerprint matches)', async () => {
    const t = await setup();
    const row = onlyRow(t.seams.get(PREF_STORE_KEY)!);
    expect(row.recordKey).toBe(t.pref.dedupeKey);
    const seamData = row.build(H, ORIGIN, undefined) as Record<string, unknown>;
    // The in-process hook (routes.ts) — scrub: redactForLiveTail.
    const hookData = buildPrefRecordData({ entry: t.pref, hlc: H, op: 'put', origin: ORIGIN, observed: undefined, scrub: redactForLiveTail }) as unknown as Record<string, unknown>;
    const unscrubbed = buildPrefRecordData({ entry: t.pref, hlc: H, op: 'put', origin: ORIGIN, observed: undefined }) as unknown as Record<string, unknown>;
    const reg = t.regs.get(PREF_STORE_KEY)!;
    expect(fp(reg, seamData)).toBe(fp(reg, hookData));
    expect(fp(reg, seamData)).not.toBe(fp(reg, unscrubbed)); // the fixture really carries a secret
    expect(JSON.stringify(seamData)).not.toContain('sk-ABCD1234EFGH5678IJKL');
  });

  it('the routes.ts preference hook passes the scrubber (source ratchet)', () => {
    const src = fs.readFileSync(ROUTES_TS, 'utf-8');
    const calls = [...src.matchAll(/buildPrefRecordData\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/scrub:\s*redactForLiveTail/);
  });

  it('relationships', async () => {
    const t = await setup();
    const row = onlyRow(t.seams.get(RELATIONSHIP_STORE_KEY)!);
    const record = RelationshipManager.readAllFromDisk(t.relDir).records[0] as RelationshipRecord;
    const reg = t.regs.get(RELATIONSHIP_STORE_KEY)!;
    expect(fp(reg, row.build(H, ORIGIN, undefined) as Record<string, unknown>))
      .toBe(fp(reg, buildRelationshipRecordData({ record, hlc: H, origin: ORIGIN, observed: undefined }) as unknown as Record<string, unknown>));
  });

  it('knowledge', async () => {
    const t = await setup();
    const row = onlyRow(t.seams.get(KNOWLEDGE_STORE_KEY)!);
    const record = KnowledgeManager.readCatalogStrict(t.stateDir).sources[0] as KnowledgeSource;
    const reg = t.regs.get(KNOWLEDGE_STORE_KEY)!;
    expect(fp(reg, row.build(H, ORIGIN, undefined) as Record<string, unknown>))
      .toBe(fp(reg, buildKnowledgeRecordData({ record, hlc: H, origin: ORIGIN, observed: undefined }) as unknown as Record<string, unknown>));
  });

  it('userRegistry', async () => {
    const t = await setup();
    const row = onlyRow(t.seams.get(USER_STORE_KEY)!);
    const reg = t.regs.get(USER_STORE_KEY)!;
    expect(fp(reg, row.build(H, ORIGIN, undefined) as Record<string, unknown>))
      .toBe(fp(reg, buildUserRecordData({ record: t.user as unknown as UserProfile, hlc: H, origin: ORIGIN, observed: undefined }) as unknown as Record<string, unknown>));
  });

  it('learnings', async () => {
    const t = await setup();
    const row = onlyRow(t.seams.get(LEARNING_STORE_KEY)!);
    const reg = t.regs.get(LEARNING_STORE_KEY)!;
    expect(fp(reg, row.build(H, ORIGIN, undefined) as Record<string, unknown>))
      .toBe(fp(reg, buildLearningRecordData({ record: t.learning, hlc: H, origin: ORIGIN, observed: undefined }) as unknown as Record<string, unknown>));
  });

  it('evolutionActions', async () => {
    const t = await setup();
    const row = onlyRow(t.seams.get(EVOLUTION_ACTION_STORE_KEY)!);
    const reg = t.regs.get(EVOLUTION_ACTION_STORE_KEY)!;
    expect(fp(reg, row.build(H, ORIGIN, undefined) as Record<string, unknown>))
      .toBe(fp(reg, buildEvolutionActionRecordData({ record: t.action, hlc: H, origin: ORIGIN, observed: undefined }) as unknown as Record<string, unknown>));
  });

  it('fingerprints are independent of hlc and observed', async () => {
    const t = await setup();
    for (const [store, seam] of t.seams) {
      const row = onlyRow(seam);
      const reg = t.regs.get(store)!;
      const a = fp(reg, row.build(H, ORIGIN, undefined) as Record<string, unknown>);
      const b = fp(reg, row.build({ physical: 5, logical: 3, node: ORIGIN }, ORIGIN, { physical: 4, logical: 0, node: 'm_peer' }) as Record<string, unknown>);
      expect(b, store).toBe(a);
    }
  });

  it('the server wires the seams through buildReconcilerSeams and starts the reconciler (source ratchet)', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    expect(src).toMatch(/new ReplicatedStoreReconciler\(\{[\s\S]*?emitter: replicatedRecordEmitter[\s\S]*?seams: buildReconcilerSeams\(/);
    expect(src).toMatch(/replicatedStoreReconciler\.start\(\)/);
    expect(src).toMatch(/replicatedStoreReconciler\?\.stop\(\)/);
    expect(src).toMatch(/deletionIntentStateDir: config\.stateDir/);
  });
});
