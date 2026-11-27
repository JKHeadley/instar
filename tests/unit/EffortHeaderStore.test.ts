/**
 * EffortHeaderStore — header METADATA only (custody of text, salts and keys is the runtime's):
 * - operations carry no plaintext and no unsalted hash; identifier fields refuse prose;
 * - nothing but opaque metadata reaches disk (no title, salt, key or ciphertext);
 * - a title is resolved only through the injected decryptor and re-verified against the winning
 *   commitment; missing or erased custody, or a mismatching answer, reads as null;
 * - a forget suppresses serving at once, even if custody still answers;
 * - the derived header is identical for any arrival order; refused operations are never recorded;
 * - a reader re-reads the file; temp files never outlive a failed or crashed write.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  EffortHeaderStore, makeHeaderOperation, validateHeaderOperation, headerOperationHash, newTitleSalt, titleCommitment,
  type HeaderDecryptor,
} from '../../src/core/EffortHeaderStore.js';
import { sha256Hex } from '../../src/core/conversationGraph.js';

const roots: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-headers-')); roots.push(d); return d; }
afterAll(() => { for (const d of roots) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/EffortHeaderStore.test.ts' }); });
const E = 'hdr-0000000000000000000001';
const F = 'hdr-0000000000000000000002';

/** A fixture custody: bundle id -> {title, salt}; erase() drops it. */
function custody() {
  const bundles = new Map<string, { title: string; salt: string }>();
  const decrypt: HeaderDecryptor = (_h, ref) => bundles.get(ref.id) ?? null;
  return { bundles, decrypt };
}
function set(headerId: string, base: number, title: string, c: ReturnType<typeof custody>, opId?: string) {
  const salt = newTitleSalt();
  const op = makeHeaderOperation('set-effort-title', headerId, base, { title, salt, opId });
  if (op.kind === 'set-effort-title') c.bundles.set(op.bundleRef.id, { title, salt });
  return { op, content: { title, salt } };
}

describe('header operations', () => {
  it('refuse plaintext, salts, extra fields, prose identifiers and non-owner authority', () => {
    const op = makeHeaderOperation('set-effort-title', E, 0, { title: 'T' });
    expect(validateHeaderOperation(op)).not.toBeNull();
    expect(validateHeaderOperation({ ...op, title: 'T' })).toBeNull();
    expect(validateHeaderOperation({ ...op, salt: 'a'.repeat(64) })).toBeNull();
    expect(validateHeaderOperation({ ...op, authority: 'delegation' })).toBeNull();
    expect(validateHeaderOperation({ ...op, principal: 'Acme merger plan' })).toBeNull();
    expect(validateHeaderOperation({ ...op, headerId: 'Launch plan' })).toBeNull();
    expect(validateHeaderOperation({ ...makeHeaderOperation('forget-header', E, 0), titleCommitment: 'a'.repeat(64) })).toBeNull();
  });

  it('carry a salted commitment, never an unsalted title hash', () => {
    const salt = newTitleSalt();
    const op = makeHeaderOperation('set-effort-title', E, 0, { title: 'Launch', salt });
    const json = JSON.stringify(op);
    expect(json).not.toContain(sha256Hex('Launch'));
    expect(json).not.toContain(salt);
    expect(op.kind === 'set-effort-title' && op.titleCommitment).toBe(titleCommitment('Launch', salt));
  });
});

describe('EffortHeaderStore', () => {
  it('persists only opaque metadata and resolves the title through custody', () => {
    const dir = tmp();
    const c = custody();
    const s = new EffortHeaderStore(dir, c.decrypt);
    const a = set(E, 0, '  Quarterly launch  ', c);
    expect(s.applyCertified(a.op, a.content)).toEqual({ applied: true, local: true });
    const disk = fs.readFileSync(s.file, 'utf8');
    expect(disk).not.toContain('Quarterly launch');
    expect(disk).not.toContain(a.content.salt);
    expect(fs.readdirSync(path.join(dir, 'conversation-graph'))).toEqual(['effort-headers.json']);
    expect(s.titleOf(E)).toBe('Quarterly launch');
    expect(new EffortHeaderStore(dir, c.decrypt).get(E)).toMatchObject({ version: 1, forgotten: false, conflicts: [], held: [] });
  });

  it('refuses a bundle that does not match the commitment, and verifies custody again on read', () => {
    const c = custody();
    const s = new EffortHeaderStore(tmp(), c.decrypt);
    const a = set(E, 0, 'Launch', c);
    expect(s.applyCertified(a.op, { title: 'Other', salt: a.content.salt })).toEqual({ applied: false, reason: 'commitment-mismatch' });
    expect(s.applyCertified(a.op, null)).toEqual({ applied: false, reason: 'title-required' });
    s.applyCertified(a.op, a.content);
    if (a.op.kind === 'set-effort-title') c.bundles.set(a.op.bundleRef.id, { title: 'Swapped', salt: a.content.salt });
    expect(s.titleOf(E)).toBeNull(); // custody answering with different text is not believed
  });

  it('reads as null when custody is missing or erased', () => {
    const c = custody();
    const s = new EffortHeaderStore(tmp(), c.decrypt);
    const a = set(E, 0, 'Plan', c);
    s.applyCertified(a.op, a.content);
    c.bundles.clear();
    expect(s.titleOf(E)).toBeNull();
  });

  it('a forget suppresses serving at once, even while custody still answers, and refuses later sets', () => {
    const c = custody();
    const s = new EffortHeaderStore(tmp(), c.decrypt);
    const a = set(E, 0, 'Very private plan', c);
    s.applyCertified(a.op, a.content);
    expect(s.applyCertified(makeHeaderOperation('forget-header', E, 1), null)).toEqual({ applied: true, local: true });
    expect(s.titleOf(E)).toBeNull();
    const late = set(E, 0, 'Very private plan', c);
    expect(s.applyCertified(late.op, late.content)).toEqual({ applied: false, reason: 'forgotten' });
    expect(s.get(E)).toMatchObject({ version: 2, forgotten: true, current: null });
  });

  it('derives the same header in every arrival order, including forgets and refused sets', () => {
    const c = custody();
    const v1 = set(E, 0, 'One', c, 'hop-000000001');
    const v2a = set(E, 1, 'Two A', c, 'hop-00000002a');
    const v2b = set(E, 1, 'Two B', c, 'hop-00000002b');
    const v4 = set(E, 3, 'Four', c, 'hop-000000004');
    const orders = [[v1, v2a, v2b, v4], [v4, v2b, v2a, v1], [v2a, v4, v1, v2b]];
    const results = orders.map((ops) => { const s = new EffortHeaderStore(tmp(), c.decrypt); for (const x of ops) s.applyCertified(x.op, x.content); return s.get(E); });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const winner = headerOperationHash(v2a.op) < headerOperationHash(v2b.op) ? v2a : v2b;
    const loser = winner === v2a ? v2b : v2a;
    expect(results[0]).toMatchObject({ version: 2, conflicts: [loser.op.opId], held: [v4.op.opId], current: { opId: winner.op.opId } });

    const forget = makeHeaderOperation('forget-header', E, 3, { opId: 'hop-forget-v3' });
    const bad = set(E, 0, 'X', c, 'hop-badcontent');
    const x = new EffortHeaderStore(tmp(), c.decrypt);
    x.applyCertified(bad.op, null); x.applyCertified(forget, null);
    const y = new EffortHeaderStore(tmp(), c.decrypt);
    y.applyCertified(forget, null); y.applyCertified(bad.op, bad.content);
    expect(x.get(E)).toEqual(y.get(E));
    expect(x.get(E)?.version).toBe(4);
  });

  it('a reused opId with different content resolves to the smaller hash in either order', () => {
    const c = custody();
    const a = set(E, 0, 'One', c, 'hop-same-id-1');
    // the same opId with different content and its OWN bundle (a fixture keyed by bundle id would
    // otherwise overwrite the first copy's custody)
    const bSalt = newTitleSalt();
    const bOp = { ...makeHeaderOperation('set-effort-title', E, 0, { title: 'Two', salt: bSalt, opId: 'hop-same-id-1' }), bundleRef: { kind: 'header-source-bundle' as const, id: 'b-second-copy' } };
    c.bundles.set('b-second-copy', { title: 'Two', salt: bSalt });
    const b = { op: bOp, content: { title: 'Two', salt: bSalt } };
    const s1 = new EffortHeaderStore(tmp(), c.decrypt);
    s1.applyCertified(a.op, a.content); s1.applyCertified(b.op, b.content);
    const s2 = new EffortHeaderStore(tmp(), c.decrypt);
    s2.applyCertified(b.op, b.content); s2.applyCertified(a.op, a.content);
    expect(s1.get(E)).toEqual(s2.get(E));
    const smaller = headerOperationHash(a.op) < headerOperationHash(b.op) ? 'One' : 'Two';
    expect(s1.titleOf(E)).toBe(smaller);
    expect(s1.applyCertified(a.op, a.content).applied).toBe(false); // duplicate or opid-conflict, never a second copy
  });

  it('nothing reusing an opId can displace a forget or bring erased text back', () => {
    const c = custody();
    const s = new EffortHeaderStore(tmp(), c.decrypt);
    const a = set(E, 0, 'Erased', c);
    s.applyCertified(a.op, a.content);
    const forget = makeHeaderOperation('forget-header', E, 1, { opId: 'hop-forget-1' });
    s.applyCertified(forget, null);
    for (let i = 0; i < 20; i++) { // try many salts so some hash sorts below the forget's
      const r = set(E, 1, 'Erased', c, 'hop-forget-1');
      expect(s.applyCertified(r.op, r.content)).toEqual({ applied: false, reason: 'opid-conflict' });
    }
    expect(s.titleOf(E)).toBeNull();
    expect(s.get(E)).toMatchObject({ forgotten: true });
  });

  it('a forget reusing a set\'s opId still forgets, whichever arrived first', () => {
    for (let i = 0; i < 20; i++) {
      const c = custody();
      const a = set(E, 0, 'Erased', c, 'hop-shared-id');
      const forget = makeHeaderOperation('forget-header', E, 1, { opId: 'hop-shared-id' });
      const x = new EffortHeaderStore(tmp(), c.decrypt);
      x.applyCertified(a.op, a.content); x.applyCertified(forget, null);
      const y = new EffortHeaderStore(tmp(), c.decrypt);
      y.applyCertified(forget, null); y.applyCertified(a.op, a.content);
      expect(x.titleOf(E)).toBeNull();
      expect(x.get(E)).toEqual(y.get(E));
      expect(x.get(E)).toMatchObject({ forgotten: true });
    }
  });

  it('a second instance sees a forget: no resurrection on write, no stale title on read', () => {
    const dir = tmp();
    const c = custody();
    const A = new EffortHeaderStore(dir, c.decrypt);
    const B = new EffortHeaderStore(dir, c.decrypt);
    const a = set(E, 0, 'Very private plan', c);
    A.applyCertified(a.op, a.content);
    expect(B.titleOf(E)).toBe('Very private plan');
    B.applyCertified(makeHeaderOperation('forget-header', E, 1), null);
    expect(A.titleOf(E)).toBeNull();
    const f = set(F, 0, 'Other', c);
    A.applyCertified(f.op, f.content);
    expect(new EffortHeaderStore(dir, c.decrypt).get(E)).toMatchObject({ forgotten: true });
  });

  it('refuses to start on a file it cannot read, rather than replacing it', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'conversation-graph'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'conversation-graph', 'effort-headers.json'), '{"schemaVersion":3,"headers":{}}');
    expect(() => new EffortHeaderStore(dir, custody().decrypt)).toThrow(/unreadable/);
  });

  it('a failed write leaves no temp file; a crashed writer\'s temp is swept, a live writer\'s kept', () => {
    const dir = tmp();
    const c = custody();
    const s = new EffortHeaderStore(dir, c.decrypt);
    const a = set(E, 0, 'Plan', c);
    s.applyCertified(a.op, a.content);
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk gone'); });
    try { expect(() => s.applyCertified(makeHeaderOperation('forget-header', E, 1), null)).toThrow(/disk gone/); } finally { spy.mockRestore(); }
    const cg = path.join(dir, 'conversation-graph');
    expect(fs.readdirSync(cg).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const stale = path.join(cg, 'effort-headers.json.999999.tmp');
    const live = path.join(cg, `effort-headers.json.${process.ppid}.tmp`);
    fs.writeFileSync(stale, '{}');
    fs.writeFileSync(live, '{}');
    new EffortHeaderStore(dir, c.decrypt);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });
});
