import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  versionCardId, versionCardKey, buildVersionCard, buildVersionAnswer, buildSummary, buildKeyRevoked, buildRevokeConfirm,
  validateCustomRecord, foldServedVersion, foldRevokedKeys, eraseProgress, foldSummary, matchApprovals,
  type UnionEntry, type SourceCandidate, type CardPurpose,
} from '../../src/core/ProjectAppCustomFold.js';
import { projectAppRecordStoreSchema } from '../../src/core/ProjectAppStore.js';
import { buildRecord } from '../../src/core/WorkCardStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const APP = 'pa_0123456789abcdef';
const OWNER = 'owner-justin';
const MEMBER = 'member-sam';
const isOwner = (k: string) => k === OWNER;
const at = '2026-11-17T01:00:00.000Z';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const A = sha('content A'); const B = sha('content B');
let tick = 1_000;
const hlc = (node = 'm_a'): HlcTimestamp => ({ physical: tick++, logical: 0, node });

type Build = (h: HlcTimestamp, o: string) => Record<string, unknown> | null;
function add(u: UnionEntry[], b: Build, node = 'm_a'): Record<string, unknown> {
  const d = b(hlc(node), node); if (!d) throw new Error('builder refused');
  u.push({ data: d, origin: node }); return d;
}

class World {
  records: UnionEntry[] = [];
  wb: UnionEntry[] = [];
  gens = new Map<CardPurpose, number>();
  /** The lease holder opens or rewrites a card generation; the material includes the generation. */
  card(purpose: CardPurpose, o: { contentSha?: string; target?: number } = {}): { cardId: string; materialHash: string } {
    const gen = (this.gens.get(purpose) ?? 0) + 1; this.gens.set(purpose, gen);
    const materialHash = sha(`${purpose}:${o.contentSha ?? o.target ?? '-'}:${gen}`);
    add(this.records, buildVersionCard({ appId: APP, purpose, gen, materialHash, ...o, at }));
    return { cardId: versionCardId(APP, purpose), materialHash };
  }
  tap(cardId: string, action: 'approve' | 'withdraw-approval', o: { materialHash?: string; personKey?: string; proof?: 'presence' | 'pin' } = {}): void {
    const by = { kind: 'person', personKey: o.personKey ?? OWNER, proof: o.proof ?? 'presence' };
    add(this.wb, buildRecord('tap', cardId, { by, at, action, ...(o.materialHash ? { materialHash: o.materialHash } : {}) }) as Build);
  }
  /** Replay an existing tap record verbatim (same key, same HLC): what a hijacked agent can re-send. */
  replay(rec: UnionEntry): void { this.wb.push({ data: { ...rec.data }, origin: rec.origin }); }
  answer(contentSha: string, answer: 'reject' | 'disable' | 'enable'): void {
    add(this.records, buildVersionAnswer({ appId: APP, contentSha, answer, by: 'owner', via: 'phone', at }));
  }
  fold(candidates: SourceCandidate[]) { return foldServedVersion({ appId: APP, records: this.records, workBoard: this.wb, isOwner, candidates }); }
}

const cand = (contentSha: string, physical: number, o: Partial<SourceCandidate> = {}): SourceCandidate => ({ id: `rev:${APP}:${physical}.0.m_a`, contentSha, hlc: { physical, logical: 0, node: 'm_a' }, complete: true, ...o });
const revA = cand(A, 10); const revB = cand(B, 20);

describe('records and card ids', () => {
  it("card ids are 'wc_' + the first 16 hex of sha256(appId:purpose), distinct per purpose", () => {
    expect(versionCardId(APP, 'serve')).toBe('wc_' + sha(`${APP}:serve`).slice(0, 16));
    expect(new Set((['serve', 'allow-again', 'enable', 'budget', 'erase-data', 'delete-app'] as const).map((p) => versionCardId(APP, p))).size).toBe(6);
  });
  it('validates the card binding: purpose fields, card id, record key', () => {
    const ok = { recordType: 'project-app-version-card', appId: APP, purpose: 'serve', gen: 1, contentSha: A, cardId: versionCardId(APP, 'serve'), materialHash: A, at };
    expect(validateCustomRecord(ok)).not.toBeNull();
    expect(validateCustomRecord({ ...ok, recordKey: versionCardKey({ appId: APP, purpose: 'serve', contentSha: A, gen: 1 }) })).not.toBeNull();
    expect(validateCustomRecord({ ...ok, recordKey: versionCardKey({ appId: APP, purpose: 'serve', contentSha: A, gen: 2 }) })).toBeNull();
    expect(validateCustomRecord({ ...ok, cardId: versionCardId(APP, 'enable') })).toBeNull();
    expect(validateCustomRecord({ ...ok, contentSha: undefined })).toBeNull();
    expect(validateCustomRecord({ ...ok, purpose: 'erase-data', cardId: versionCardId(APP, 'erase-data'), contentSha: undefined })).toBeNull(); // needs a target
    expect(validateCustomRecord({ ...ok, purpose: 'erase-data', cardId: versionCardId(APP, 'erase-data'), contentSha: undefined, target: 3 })).not.toBeNull();
  });
  it('an erase-data target uses the consumer\'s own generation check; a budget target is a byte count', () => {
    const e = { recordType: 'project-app-version-card', appId: APP, purpose: 'erase-data', gen: 1, cardId: versionCardId(APP, 'erase-data'), materialHash: A, at };
    expect(validateCustomRecord({ ...e, target: 1_000_000 })).not.toBeNull();
    expect(validateCustomRecord({ ...e, target: 2_000_000 })).toBeNull();
    const b = { ...e, purpose: 'budget', cardId: versionCardId(APP, 'budget') };
    expect(validateCustomRecord({ ...b, target: 16 * 1024 * 1024 })).not.toBeNull();
    expect(validateCustomRecord({ ...b, target: 2 ** 60 })).toBeNull();
  });
  it('an approved erase binding with target 2000000 folds to no watermark, and a valid revoke record still folds', () => {
    const w = new World();
    // A peer's raw record (the builder would refuse it), approved by the owner's phone.
    const materialHash = sha('erase-data:2000000:1');
    w.records.push({ data: { recordType: 'project-app-version-card', appId: APP, purpose: 'erase-data', gen: 1, target: 2_000_000, cardId: versionCardId(APP, 'erase-data'), materialHash, at, recordKey: 'vcard:' + APP + ':erase-data:2000000:1', hlc: hlc(), op: 'put', origin: 'm_a' }, origin: 'm_a' });
    w.tap(versionCardId(APP, 'erase-data'), 'approve', { materialHash });
    add(w.records, buildKeyRevoked({ appId: APP, keyKind: 'source', gen: 1, at }));
    const r = foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner });
    expect(r.eraseWatermarks[APP]).toBeUndefined();
    expect(r.revoked).toEqual([{ appId: APP, keyKind: 'source', gen: 1 }]);
  });
  it('a summary with asOf later than at is refused; the part-1 schema keeps malformed part-2 records as inert stubs', () => {
    const s = { recordType: 'project-app-summary', appId: APP, keyGen: 1, sealed: { nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }, asOf: at, by: 'app', at };
    expect(validateCustomRecord(s)).not.toBeNull();
    expect(validateCustomRecord({ ...s, asOf: '2026-11-18T00:00:00.000Z' })).toBeNull();
    const ctx = { countDroppedField() {}, countJailReject() {} } as never;
    expect(projectAppRecordStoreSchema.validate(s, ctx)).toMatchObject({ recordType: 'project-app-summary', appId: APP, keyGen: 1 });
    expect(projectAppRecordStoreSchema.validate({ ...s, asOf: '2026-11-18T00:00:00.000Z' }, ctx)).toEqual({ recordType: 'project-app-summary' });
    const big = { ...s, sealed: { nonce: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(70 * 1024) } };
    expect(projectAppRecordStoreSchema.validate(big, ctx)).toEqual({ recordType: 'project-app-summary' });
  });
});

describe('the served-version fold', () => {
  it('nothing serves until the owner approves on the phone; then the approved content serves', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A });
    expect(w.fold([revA]).served).toBeNull();
    w.tap(c.cardId, 'approve', { materialHash: c.materialHash });
    expect(w.fold([revA]).served?.id).toBe(revA.id);
  });
  it('a PIN (console) approve never serves', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A });
    w.tap(c.cardId, 'approve', { materialHash: c.materialHash, proof: 'pin' });
    expect(w.fold([revA]).served).toBeNull();
  });
  it("a member's presence approve never serves", () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A });
    w.tap(c.cardId, 'approve', { materialHash: c.materialHash, personKey: MEMBER });
    expect(w.fold([revA]).served).toBeNull();
  });
  it('an approve whose material does not match the card generation never serves', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A });
    w.tap(c.cardId, 'approve', { materialHash: sha('some other rendering') });
    expect(w.fold([revA]).served).toBeNull();
  });
  it('a replayed old approve does not serve a newer generation (a rewritten card serves nothing until re-approved)', () => {
    const w = new World();
    const c1 = w.card('serve', { contentSha: A });
    w.tap(c1.cardId, 'approve', { materialHash: c1.materialHash });
    const oldTap = w.wb[w.wb.length - 1];
    const c2 = w.card('serve', { contentSha: B }); // rewritten to the newer revision
    w.replay(oldTap);
    // re-sent with a new HLC, the old signed material still binds generation 1 (content A) only
    w.tap(c1.cardId, 'approve', { materialHash: c1.materialHash });
    const v = w.fold([revA, revB]);
    expect(v.served?.contentSha).toBe(A);
    expect(v.contents.get(B)?.approved ?? false).toBe(false);
    w.tap(c2.cardId, 'approve', { materialHash: c2.materialHash });
    expect(w.fold([revA, revB]).served?.contentSha).toBe(B);
  });
  it('any generation for the same content matches (a revert to earlier content gets a working card)', () => {
    const w = new World();
    const c1 = w.card('serve', { contentSha: A });
    w.tap(c1.cardId, 'approve', { materialHash: c1.materialHash });
    w.card('serve', { contentSha: B });
    const c3 = w.card('serve', { contentSha: A });
    w.tap(c3.cardId, 'approve', { materialHash: c3.materialHash });
    const revA2 = cand(A, 30);
    expect(w.fold([revA, revB, revA2]).served?.id).toBe(revA2.id);
  });
  it('reject → allow-again → reject; replaying the earlier approves never revives it', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A });
    w.tap(c.cardId, 'approve', { materialHash: c.materialHash });
    const serveTap = w.wb[w.wb.length - 1];
    w.answer(A, 'reject');
    expect(w.fold([revA]).served).toBeNull();
    // a fresh serve approve after the reject does not unblock: only allow-again does
    w.tap(c.cardId, 'approve', { materialHash: c.materialHash });
    expect(w.fold([revA]).served).toBeNull();
    const aa = w.card('allow-again', { contentSha: A });
    w.tap(aa.cardId, 'approve', { materialHash: aa.materialHash });
    const allowTap = w.wb[w.wb.length - 1];
    expect(w.fold([revA]).served?.id).toBe(revA.id);
    w.answer(A, 'reject');
    expect(w.fold([revA]).served).toBeNull();
    w.replay(serveTap); w.replay(allowTap);
    w.tap(aa.cardId, 'approve', { materialHash: aa.materialHash }); // re-sent with a new HLC: its card generation predates the reject
    expect(w.fold([revA]).served).toBeNull();
    expect(w.fold([revA]).contents.get(A)).toEqual({ approved: true, rejected: true });
    const aa2 = w.card('allow-again', { contentSha: A });
    w.tap(aa2.cardId, 'approve', { materialHash: aa2.materialHash });
    expect(w.fold([revA]).served?.id).toBe(revA.id);
  });
  it('a reject of a newer version leaves the older approved one serving', () => {
    const w = new World();
    const c1 = w.card('serve', { contentSha: A }); w.tap(c1.cardId, 'approve', { materialHash: c1.materialHash });
    const c2 = w.card('serve', { contentSha: B }); w.tap(c2.cardId, 'approve', { materialHash: c2.materialHash });
    expect(w.fold([revA, revB]).served?.contentSha).toBe(B);
    w.answer(B, 'reject');
    expect(w.fold([revA, revB]).served?.contentSha).toBe(A);
  });
  it('withdraw-approval (any surface, even a PIN tap) disables; enable needs a presence approve on an enable card', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A }); w.tap(c.cardId, 'approve', { materialHash: c.materialHash });
    w.tap(c.cardId, 'withdraw-approval', { proof: 'pin' });
    expect(w.fold([revA]).disabled).toBe(true);
    expect(w.fold([revA]).served).toBeNull();
    w.answer(A, 'enable'); // an enable answer alone is not the authority
    expect(w.fold([revA]).served).toBeNull();
    const e = w.card('enable', { contentSha: A });
    w.tap(e.cardId, 'approve', { materialHash: e.materialHash, proof: 'pin' });
    expect(w.fold([revA]).served).toBeNull();
    w.tap(e.cardId, 'approve', { materialHash: e.materialHash });
    expect(w.fold([revA]).served?.id).toBe(revA.id);
    w.answer(A, 'disable');
    expect(w.fold([revA]).served).toBeNull();
  });
  it('the newest complete approved revision serves; a newer approved one still copying is reported', () => {
    const w = new World();
    const c1 = w.card('serve', { contentSha: A }); w.tap(c1.cardId, 'approve', { materialHash: c1.materialHash });
    const c2 = w.card('serve', { contentSha: B }); w.tap(c2.cardId, 'approve', { materialHash: c2.materialHash });
    const v = w.fold([revA, cand(B, 20, { complete: false })]);
    expect(v.served?.contentSha).toBe(A);
    expect(v.newerApprovedCopying).toBe(true);
  });
  it('a fenced late revision is never served even when its content is approved', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: B }); w.tap(c.cardId, 'approve', { materialHash: c.materialHash });
    expect(w.fold([cand(B, 20, { fenced: true })]).served).toBeNull();
  });
  it('an approve on the delete-app card stops serving', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A }); w.tap(c.cardId, 'approve', { materialHash: c.materialHash });
    const d = w.card('delete-app'); w.tap(d.cardId, 'approve', { materialHash: d.materialHash });
    const v = w.fold([revA]);
    expect(v.deleted).toBe(true);
    expect(v.served).toBeNull();
  });
  it('taps on another app or a non-version card are ignored', () => {
    const w = new World();
    const c = w.card('serve', { contentSha: A });
    w.tap('wc_0000000000000000', 'approve', { materialHash: c.materialHash });
    expect(matchApprovals(APP, w.records, w.wb, isOwner)).toEqual([]);
  });
});

describe('revoked key generations', () => {
  it('an owner-presence approve on erase-data revokes every data generation ≤ its target, with no revoke record', () => {
    const w = new World();
    const e = w.card('erase-data', { target: 3 });
    expect(foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner }).isRevoked(APP, 'data', 1)).toBe(false);
    w.tap(e.cardId, 'approve', { materialHash: e.materialHash });
    const r = foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner });
    expect(r.isRevoked(APP, 'data', 1)).toBe(true);
    expect(r.isRevoked(APP, 'data', 3)).toBe(true);
    expect(r.isRevoked(APP, 'data', 4)).toBe(false);
    expect(r.isRevoked(APP, 'source', 1)).toBe(false);
    expect(r.eraseWatermarks[APP]).toBe(3);
  });
  it('a PIN or member approve on erase-data revokes nothing', () => {
    const w = new World();
    const e = w.card('erase-data', { target: 3 });
    w.tap(e.cardId, 'approve', { materialHash: e.materialHash, proof: 'pin' });
    w.tap(e.cardId, 'approve', { materialHash: e.materialHash, personKey: MEMBER });
    expect(foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner }).isRevoked(APP, 'data', 1)).toBe(false);
  });
  it('a delete-app approve revokes every kind; a revoke record revokes exactly its generation', () => {
    const w = new World();
    add(w.records, buildKeyRevoked({ appId: APP, keyKind: 'source', gen: 2, at }));
    let r = foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner });
    expect(r.isRevoked(APP, 'source', 2)).toBe(true);
    expect(r.isRevoked(APP, 'source', 1)).toBe(false);
    const d = w.card('delete-app'); w.tap(d.cardId, 'approve', { materialHash: d.materialHash });
    r = foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner });
    expect(r.deletedApps.has(APP)).toBe(true);
    expect(r.isRevoked(APP, 'hmac', 7)).toBe(true);
  });
  it('an erase is done only when every live machine confirmed every generation', () => {
    const w = new World();
    add(w.records, buildRevokeConfirm({ appId: APP, keyKind: 'data', gen: 1, machineId: 'm_a', at }));
    add(w.records, buildRevokeConfirm({ appId: APP, keyKind: 'data', gen: 2, machineId: 'm_a', at }));
    add(w.records, buildRevokeConfirm({ appId: APP, keyKind: 'data', gen: 1, machineId: 'm_b', at }));
    const gens = [{ keyKind: 'data' as const, gen: 1 }, { keyKind: 'data' as const, gen: 2 }];
    expect(eraseProgress(w.records, APP, gens, ['m_a', 'm_b'])).toEqual({ done: false, waitingOn: ['m_b'] });
    add(w.records, buildRevokeConfirm({ appId: APP, keyKind: 'data', gen: 2, machineId: 'm_b', at }));
    expect(eraseProgress(w.records, APP, gens, ['m_a', 'm_b'])).toEqual({ done: true, waitingOn: [] });
  });
  it('the summary reads erased once its data generation is revoked', () => {
    const w = new World();
    add(w.records, buildSummary({ appId: APP, keyGen: 1, sealed: { nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }, asOf: at, by: 'app', at }));
    expect(foldSummary(w.records, APP, foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner }))?.erased).toBe(false);
    const e = w.card('erase-data', { target: 1 }); w.tap(e.cardId, 'approve', { materialHash: e.materialHash });
    expect(foldSummary(w.records, APP, foldRevokedKeys({ records: w.records, workBoard: w.wb, isOwner }))?.erased).toBe(true);
  });
});
