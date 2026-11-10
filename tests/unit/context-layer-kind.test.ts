/**
 * The replicated layer kind (context-budget-layered-summaries §14): schema
 * boundaries on both sides, refuse-never-truncate on content records only,
 * unique per-entry keys, and the dual-registry wiring (a kind whose wiring is
 * silently dropped passes the schema tests but fails here).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTEXT_LAYER_KIND_REGISTRATION, CONTEXT_LAYER_RECORD_KIND, CONTEXT_LAYER_STORE_KEY, CONTEXT_LAYER_KIND_BOUNDS,
  contextLayerRecordStoreSchema, buildContextLayerPut, maxRecordBytesFor, bodyWireBytes,
} from '../../src/monitoring/contextLayerKind.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION, DEFAULT_MAX_ENTRY_BYTES, REPLICATED_RECORD_MAX_ENTRY_BYTES } from '../../src/core/CoherenceJournal.js';
import { RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const ctx = () => { const c = { dropped: 0, jail: 0 }; return { c, v: { countDroppedField: () => { c.dropped++; }, countJailReject: () => { c.jail++; } } }; };
const H = { physical: 1, logical: 0, node: 'm' };

describe('context layer kind — schema', () => {
  const key = (t: string, type: string, e: string) => `${t}:${type}:${e}`;
  const put = (o: Record<string, unknown>) => ({ ...o, recordKey: key(String(o.topicKey), String(o.recordType), String(o.entryKey)), op: 'put' });

  it('caps derive from the journal constants: 8 KB default, 64 KB for H3 and sidecars, with envelope room under the 80 KB wire cap', () => {
    expect(CONTEXT_LAYER_KIND_BOUNDS.maxRecordBytes.default).toBe(DEFAULT_MAX_ENTRY_BYTES);
    expect(maxRecordBytesFor('h3')).toBe(64 * 1024);
    expect(maxRecordBytesFor('fold-sidecar')).toBe(64 * 1024);
    expect(maxRecordBytesFor('chunk')).toBe(8 * 1024);
    expect(maxRecordBytesFor('h3')! + 8 * 1024).toBeLessThanOrEqual(REPLICATED_RECORD_MAX_ENTRY_BYTES);
    for (const t of ['fold-record', 'fold-hold', 'fold-backoff', 'fold-breaker']) expect(maxRecordBytesFor(t)).toBeNull();
    expect(CONTEXT_LAYER_KIND_BOUNDS.liveSetBudget).toBeNull(); // sized in Phase 1
  });

  it('a content record at its cap is accepted; one byte over is REFUSED (never truncated)', () => {
    const at = buildContextLayerPut({ recordType: 'h1', topicKey: '141133', entryKey: 'h1', body: 'x'.repeat(8 * 1024) });
    expect(at.ok).toBe(true);
    if (at.ok) expect((at.build(H, 'm').body as string).length).toBe(8 * 1024);
    expect(buildContextLayerPut({ recordType: 'h1', topicKey: '141133', entryKey: 'h1', body: 'x'.repeat(8 * 1024 + 1) })).toEqual({ ok: false, reason: 'oversize' });
    // Bytes, not characters: 3-byte characters count three times.
    expect(buildContextLayerPut({ recordType: 'h1', topicKey: '141133', entryKey: 'h1', body: '€'.repeat(2731) })).toEqual({ ok: false, reason: 'oversize' });
    expect(buildContextLayerPut({ recordType: 'h3', topicKey: '141133', entryKey: 'h3', body: 'x'.repeat(60 * 1024) }).ok).toBe(true);
    expect(buildContextLayerPut({ recordType: 'h3', topicKey: '141133', entryKey: 'h3', body: 'x'.repeat(64 * 1024 + 1) })).toEqual({ ok: false, reason: 'oversize' });
    const { v } = ctx();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'h1', topicKey: '141133', entryKey: 'h1', body: 'x'.repeat(8 * 1024 + 1) }), v)).toBeNull();
  });

  it('the cap is the ESCAPED size the journal line carries (newlines, quotes, control characters)', () => {
    expect(bodyWireBytes('a\n"b')).toBe(6); // a, \n (2), \" (2), b
    expect(buildContextLayerPut({ recordType: 'h3', topicKey: '1', entryKey: 'h3', body: '\n'.repeat(33 * 1024) })).toEqual({ ok: false, reason: 'oversize' });
    expect(buildContextLayerPut({ recordType: 'h3', topicKey: '1', entryKey: 'h3', body: '"'.repeat(32 * 1024) }).ok).toBe(true);
    expect(buildContextLayerPut({ recordType: 'chunk', topicKey: '1', entryKey: 'c', body: '\u0001'.repeat(1400) })).toEqual({ ok: false, reason: 'oversize' });
  });

  it('state records are never size-refused; a body is dropped and counted; backoff and breaker carry counters', () => {
    expect(buildContextLayerPut({ recordType: 'fold-record', topicKey: '141133', entryKey: 'f1', foldId: 'f1', state: 'committed', seq: 9, generation: 2 }).ok).toBe(true);
    expect(buildContextLayerPut({ recordType: 'fold-backoff', topicKey: '141133', entryKey: 'stage', count: 2, untilMs: 1_800_000_000_000 }).ok).toBe(true);
    expect(buildContextLayerPut({ recordType: 'fold-breaker', topicKey: '141133', entryKey: 'stage', status: 'open', count: 3 }).ok).toBe(true);
    const { c, v } = ctx();
    const out = contextLayerRecordStoreSchema.validate(put({ recordType: 'fold-record', topicKey: '141133', entryKey: 'f1', foldId: 'f1', state: 'locked', body: 'x'.repeat(200_000) }), v);
    expect(out).toEqual({ recordType: 'fold-record', topicKey: '141133', entryKey: 'f1', foldId: 'f1', state: 'locked' });
    expect(c.dropped).toBe(1);
  });

  it('refuses unsafe ids, a bad entry key, bad counters, a fold record without a state, and a content record without a body', () => {
    const { v } = ctx();
    const ok = put({ recordType: 'anchor', topicKey: '141133', entryKey: 'a', body: 'a' });
    expect(contextLayerRecordStoreSchema.validate(ok, v)).toEqual({ recordType: 'anchor', topicKey: '141133', entryKey: 'a', body: 'a' });
    expect(contextLayerRecordStoreSchema.validate({ ...ok, topicKey: '../etc' }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate({ ...ok, foldId: 'a/b' }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate({ ...ok, body: 7 }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate({ ...ok, recordType: 'H4!' }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'fold-record', topicKey: '1', entryKey: 'f' }), v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'fold-record', topicKey: '1', entryKey: 'f', state: 'locked', seq: -1 }), v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'fold-record', topicKey: '1', entryKey: 'f', state: 'locked', seq: 1.5 }), v)).toBeNull();
    expect(buildContextLayerPut({ recordType: 'chunk', topicKey: '1', entryKey: 'bad key', body: 'x' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('the record key is BOUND to the fields: a mismatched or missing entry key is refused', () => {
    const { v } = ctx();
    const rec = { recordType: 'chunk', topicKey: '141133', entryKey: 'c1', body: 'x', op: 'put' };
    expect(contextLayerRecordStoreSchema.validate({ ...rec, recordKey: '999:anchor:zzz' }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate({ recordType: 'anchor', topicKey: '1', body: 'x', recordKey: 'whatever', op: 'put' }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate({ ...rec, recordKey: '141133:chunk:c1' }, v)).not.toBeNull();
  });

  it('FORWARD COMPATIBLE: a well-formed type or fold state from a later build is accepted on receive (default cap), never stalling the stream', () => {
    const { v } = ctx();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'h4', topicKey: '1', entryKey: 'e', body: 'later build' }), v)).toMatchObject({ recordType: 'h4', body: 'later build' });
    // A later STATE-like type (no body), a bigger body (up to the 64 KB raise), a non-string body (dropped), a new status value.
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'fold-cooldown', topicKey: '1', entryKey: 'e', count: 2 }), v)).toMatchObject({ recordType: 'fold-cooldown', count: 2 });
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'h4', topicKey: '1', entryKey: 'e', body: 'x'.repeat(20 * 1024) }), v)).not.toBeNull();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'h4', topicKey: '1', entryKey: 'e', body: 'x'.repeat(64 * 1024 + 1) }), v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'h4', topicKey: '1', entryKey: 'e', body: { rich: true } }), v)).toEqual({ recordType: 'h4', topicKey: '1', entryKey: 'e' });
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'ledger-entry', topicKey: '1', entryKey: 'g', body: 'x', status: 'Body.Elsewhere' }), v)).toMatchObject({ status: 'Body.Elsewhere' });
    expect(contextLayerRecordStoreSchema.validate(put({ recordType: 'fold-record', topicKey: '1', entryKey: 'f', state: 'pre-staged' }), v)).toMatchObject({ state: 'pre-staged' });
    // ...but this build never WRITES an unknown state.
    expect(buildContextLayerPut({ recordType: 'fold-record', topicKey: '1', entryKey: 'f', state: 'pre-staged' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('the builder refuses what the envelope would jail or the schema would drop, and builds only validated fields', () => {
    expect(buildContextLayerPut({ recordType: 'ledger-entry', topicKey: '1', entryKey: 'g', body: 'x', status: 'in/progress' })).toEqual({ ok: false, reason: 'invalid' });
    expect(buildContextLayerPut({ recordType: 'fold-hold', topicKey: '1', entryKey: 'h', state: 'bogus' })).toEqual({ ok: false, reason: 'invalid' });
    expect(buildContextLayerPut({ recordType: 'fold-hold', topicKey: '1', entryKey: 'h', body: 'no body on state' })).toEqual({ ok: false, reason: 'invalid' });
    expect(buildContextLayerPut({ recordType: 'fold-hold', topicKey: '1', entryKey: 'h', seq: -4 })).toEqual({ ok: false, reason: 'invalid' });
    const r = buildContextLayerPut({ recordType: 'anchor', topicKey: '1', entryKey: 'a', body: 'goal', extra: 'smuggled' } as never);
    if (!r.ok) throw new Error(r.reason);
    expect(r.build(H, 'm')).not.toHaveProperty('extra');
  });

  it('a delete tombstone needs only type and topic; one that names its entry must match its key', () => {
    const { v } = ctx();
    expect(contextLayerRecordStoreSchema.validate({ recordType: 'chunk', topicKey: '1', op: 'delete', recordKey: '1:chunk:c' }, v)).toEqual({ recordType: 'chunk', topicKey: '1' });
    expect(contextLayerRecordStoreSchema.validate({ recordType: 'chunk', topicKey: '1', entryKey: 'c', op: 'delete', recordKey: '1:chunk:other' }, v)).toBeNull();
    expect(contextLayerRecordStoreSchema.validate({ recordType: 'anchor', topicKey: '141133', op: 'delete', recordKey: '999:anchor:zzz' }, v)).toBeNull();
  });

  it('record keys are unique per entry; a status change re-emits the SAME key (HLC-latest wins)', () => {
    const a = buildContextLayerPut({ recordType: 'ledger-entry', topicKey: '141133', entryKey: 'g1', body: 'decision', status: 'live' });
    const b = buildContextLayerPut({ recordType: 'ledger-entry', topicKey: '141133', entryKey: 'g1', body: 'decision', status: 'superseded' });
    const c = buildContextLayerPut({ recordType: 'ledger-entry', topicKey: '141133', entryKey: 'g2', body: 'other' });
    if (!a.ok || !b.ok || !c.ok) throw new Error('build');
    expect(a.recordKey).toBe('141133:ledger-entry:g1');
    expect(b.recordKey).toBe(a.recordKey);
    expect(c.recordKey).not.toBe(a.recordKey);
    expect(b.build(H, 'm')).toMatchObject({ op: 'put', origin: 'm', status: 'superseded', recordKey: a.recordKey });
  });
});

describe('context layer kind — wiring', () => {
  it('server.ts registers the kind (dynamic half) and the fold coordinator reads it as layerKindPresent', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain("await import('../monitoring/contextLayerKind.js')");
    expect(src).toContain('replicatedKindRegistry.register(CONTEXT_LAYER_KIND_REGISTRATION)');
    expect(src).toContain("layerKindPresent: () => replicatedKindRegistry.isReplicatedKind('context-layer-record')");
    // Registered before the coordinator is built (the precondition reads the registry at fold time, but
    // the boot order keeps a fold from ever seeing a half-registered build).
    expect(src.indexOf('replicatedKindRegistry.register(CONTEXT_LAYER_KIND_REGISTRATION)')).toBeLessThan(src.indexOf("await import('../monitoring/foldCoordinatorBoot.js')"));
  });

  it('CoherenceJournal carries the kind in the static half with finite retention', () => {
    expect(JOURNAL_KINDS).toContain(CONTEXT_LAYER_RECORD_KIND);
    expect(DEFAULT_RETENTION[CONTEXT_LAYER_RECORD_KIND]).toEqual({ maxFileBytes: 8 * 1024 * 1024, rotateKeep: 8 });
    expect((read('src/core/CoherenceJournal.ts').match(/'context-layer-record'/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it('the reconciler allowlist names the store and the applier maps the kind to its flag path', () => {
    expect(RECONCILER_ALLOWLIST[CONTEXT_LAYER_STORE_KEY]).toMatch(/contextLayerKind/);
    expect(read('src/core/JournalSyncApplier.ts')).toContain("'context-layer-record': 'multiMachine.stateSync.contextLayers'");
  });

  it('the registry accepts the kind, resolves it by store, and refuses a conflicting re-registration', () => {
    const reg = new ReplicatedKindRegistry();
    expect(reg.isReplicatedKind(CONTEXT_LAYER_RECORD_KIND)).toBe(false);
    reg.register(CONTEXT_LAYER_KIND_REGISTRATION);
    expect(reg.isReplicatedKind(CONTEXT_LAYER_RECORD_KIND)).toBe(true);
    expect(reg.getByStore(CONTEXT_LAYER_STORE_KEY)?.kind).toBe(CONTEXT_LAYER_RECORD_KIND);
    expect(() => reg.register(CONTEXT_LAYER_KIND_REGISTRATION)).not.toThrow();
    expect(() => reg.register({ ...CONTEXT_LAYER_KIND_REGISTRATION, store: 'other' })).toThrow();
  });

  it('DARK: no runtime call site emits to the kind yet', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    const offenders = walk(path.join(ROOT, 'src')).filter((f) => {
      if (f.endsWith('contextLayerKind.ts')) return false;
      const s = fs.readFileSync(f, 'utf-8');
      return /emit\w*\(\s*CONTEXT_LAYER_(STORE_KEY|RECORD_KIND)/.test(s) || /emitReplicatedRecord\w*\(\s*['"]context-layer-record['"]/.test(s) || /buildContextLayerPut\(/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
