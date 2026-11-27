/**
 * Wiring-integrity tests for the Chief of Staff store (docs/specs/chief-of-staff-topic.md §1.2).
 * Mirrors working-set-artifact-wiring: a kind whose wiring is silently dropped passes its unit
 * tests but fails HERE. Three layers:
 *
 *  1. SOURCE assertions — the dual registry carries `chief-of-staff-record` in BOTH halves
 *     (JOURNAL_KINDS static + server.ts registers CHIEF_OF_STAFF_KIND_REGISTRATION), the
 *     reconciler allowlist names the store, the applier maps the kind to its flag path, and the
 *     retention entry is never-delete.
 *  2. FUNCTIONAL registration — the registry accepts the kind and resolves it by store.
 *  3. DARKNESS — this PR emits nothing: no runtime call site emits to the store yet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY } from '../../src/core/ChiefOfStaffStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import { RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('Chief of Staff store wiring — 1. SOURCE assertions', () => {
  it('server.ts registers CHIEF_OF_STAFF_KIND_REGISTRATION (dual-registry dynamic half)', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain("await import('../core/ChiefOfStaffStore.js')");
    expect(src).toContain('replicatedKindRegistry.register(CHIEF_OF_STAFF_KIND_REGISTRATION)');
  });
  it('CoherenceJournal carries the kind in the static half with never-delete retention', () => {
    expect(JOURNAL_KINDS).toContain('chief-of-staff-record');
    expect(DEFAULT_RETENTION['chief-of-staff-record']).toEqual({ maxFileBytes: 8 * 1024 * 1024, rotateKeep: 0 });
    const src = read('src/core/CoherenceJournal.ts');
    // Every per-kind map must carry the kind (the compiler enforces Record<JournalKind, …>, this
    // guards the one literal-list the type system does not: the union + array stay coupled).
    expect((src.match(/'chief-of-staff-record'/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
  it('the reconciler allowlist names the store with a reason, and the applier maps the kind to its flag path', () => {
    expect(RECONCILER_ALLOWLIST.chiefOfStaff).toMatch(/ChiefOfStaffStore/);
    expect(read('src/core/JournalSyncApplier.ts')).toContain("'chief-of-staff-record': 'multiMachine.stateSync.chiefOfStaff'");
  });
});

describe('Chief of Staff store wiring — 2. FUNCTIONAL registration', () => {
  it('the registry accepts the kind and resolves it by store', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    expect(reg.isReplicatedKind(CHIEF_OF_STAFF_RECORD_KIND)).toBe(true);
    expect(reg.getByStore(CHIEF_OF_STAFF_STORE_KEY)?.kind).toBe(CHIEF_OF_STAFF_RECORD_KIND);
    // Idempotent identical re-registration; conflicting store for the same kind throws.
    expect(() => reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION)).not.toThrow();
    expect(() => reg.register({ ...CHIEF_OF_STAFF_KIND_REGISTRATION, store: 'other' })).toThrow();
  });
});

describe('Chief of Staff store wiring — 3. DARKNESS (PR 1 emits nothing)', () => {
  it('no runtime call site emits to the chiefOfStaff store yet', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    const offenders = walk(path.join(ROOT, 'src')).filter((f) => {
      if (f.endsWith('ChiefOfStaffStore.ts')) return false;
      const s = fs.readFileSync(f, 'utf-8');
      return /emit\w*\(\s*CHIEF_OF_STAFF_(STORE_KEY|RECORD_KIND)/.test(s) || /emitReplicatedRecord\w*\(\s*['"]chief-of-staff-record['"]/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

describe('Chief of Staff store wiring — 4. the store follows the feature switch (Echo Bugs 10000002562)', () => {
  // The flag was never set, so every record (the owner's check-in included) was refused 'disabled'
  // on every machine and the Chief of Staff stayed paused whichever machine served the topic.
  it('chiefOfStaffStoreEnabled follows chiefOfStaff.enabled ?? developmentAgent', async () => {
    const { chiefOfStaffStoreEnabled } = await import('../../src/core/ChiefOfStaffStore.js');
    expect(chiefOfStaffStoreEnabled({ developmentAgent: true })).toBe(true);
    expect(chiefOfStaffStoreEnabled({ developmentAgent: true, chiefOfStaff: {} })).toBe(true);
    expect(chiefOfStaffStoreEnabled({ developmentAgent: false })).toBe(false);
    expect(chiefOfStaffStoreEnabled({})).toBe(false);
    expect(chiefOfStaffStoreEnabled(undefined)).toBe(false);
    expect(chiefOfStaffStoreEnabled({ developmentAgent: false, chiefOfStaff: { enabled: true } })).toBe(true);
    expect(chiefOfStaffStoreEnabled({ developmentAgent: true, chiefOfStaff: { enabled: false } })).toBe(false);
  });

  it('server.ts forces stateSync.chiefOfStaff on in the resolved stores map the emitter and the receive advert read', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('const _chiefOfStaffStoreOn = chiefOfStaffStoreEnabled(config);');
    expect(src).toContain('if (_chiefOfStaffStoreOn) s = { ...s, chiefOfStaff: { enabled: true } };');
    // The early-return guard must count it too, or an agent with no other stateSync store drops it.
    expect(src).toMatch(/_staleOwnerReleaseResolved \|\| _chiefOfStaffStoreOn \|\| _stateSyncStoresBase \? s : _stateSyncStoresBase/);
    // The emitter reads THIS map (not raw config), so the store is live wherever the feature is.
    const at = src.indexOf('const _stateSyncStoresResolved');
    expect(at).toBeGreaterThan(src.indexOf('const _chiefOfStaffStoreOn'));
    expect(src.slice(at, at + 20_000)).toContain('stores: () => _stateSyncStoresResolved');
  });

  it('the real emitter + journal store a check-in renewal with the forced-on map, and refuse it with the old map', async () => {
    const os = await import('node:os');
    const { ReplicatedRecordEmitter } = await import('../../src/core/ReplicatedRecordEmitter.js');
    const { HybridLogicalClock } = await import('../../src/core/HybridLogicalClock.js');
    const { CoherenceJournal } = await import('../../src/core/CoherenceJournal.js');
    const { SafeFsExecutor } = await import('../../src/core/SafeFsExecutor.js');
    const { buildRenewal } = await import('../../src/core/ChiefOfStaffStore.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-store-'));
    const journal = new CoherenceJournal({ stateDir: dir, machineId: 'm_self', flushIntervalMs: 1_000_000 });
    journal.open();
    try {
      const reg = new ReplicatedKindRegistry();
      reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
      journal.setReplicatedKindRegistry(reg);
      let stores: Record<string, { enabled?: boolean }> = { preferences: { enabled: true } }; // the pre-fix map: no chiefOfStaff entry
      const emitter = new ReplicatedRecordEmitter({
        journal, clock: new HybridLogicalClock({ node: 'm_self', now: () => Date.now() }),
        registry: reg, origin: 'm_self', stores: () => stores, loadWitness: () => undefined,
      });
      const renew = (at: string) => emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `renewal:${at}:m_self`, buildRenewal({ renewedAt: at, renewedVia: 'telegram', principal: 'telegram:1', eventRef: 'telegram:141385:141871', machine: 'm_self', machineSignature: 'sig' }));
      expect(renew('2026-11-11T18:16:11.000Z').outcome).toBe('disabled');
      stores = { preferences: { enabled: true }, chiefOfStaff: { enabled: true } };
      expect(renew('2026-11-11T18:17:11.000Z').outcome).toBe('emitted');
      journal.flush();
      const rows = journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 100).entries.map((e) => e.data as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      expect(rows[0].recordType).toBe('renewal');
      expect(rows[0].renewedAt).toBe('2026-11-11T18:17:11.000Z');
    } finally {
      try { journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/chief-of-staff-store-wiring.test.ts' });
    }
  });
});
