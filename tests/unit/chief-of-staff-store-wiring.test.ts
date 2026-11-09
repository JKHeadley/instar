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
