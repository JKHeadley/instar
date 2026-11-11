/** Instar Documents service: create, revise, comment, re-anchor, reply, resolve, send, compare, access (§3.4–3.9). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService, DocError, type Caller } from '../../src/documents/service.js';
import type { TeamView } from '../../src/documents/access.js';
import { projectText } from '../../src/documents/projection.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/documents-service.test.ts' }); });

const OWN = 'app:44444444-4444-4444-8444-444444444444';
const SHARED = 'telegram:500';
const so = { keyHash: 'k', deviceId: 'd', domain: 'instar-docpage-v1' as const, payloadB64: 'e30', host: 'h', timeMs: '1', sig: 's' };

function setup(over: Partial<TeamView> = {}) {
  const kp = generateSigningKeyPair();
  const signer: MachineSigner = { machineId: () => 'A', signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: 'A', signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsvc-')); tmp.push(dir);
  const store = new DocumentStore(dir, { signer, keyLookup: () => ({ status: 'ok', publicKeyPem: kp.publicKey }), standing: () => 'ok' });
  const team: TeamView = {
    personMay: (k, ref) => ref === SHARED && (k === 'mara' || k === 'gus'),
    ownerOnly: (ref) => ref === OWN, sessionInPlace: (k, ref) => k === `place:${ref}`, teamRefusal: () => null, sendReachesOwner: () => false, ...over,
  };
  return { store, svc: new DocumentService(store, team) };
}
const bearer: Caller = { principal: { kind: 'bearer' }, actor: { type: 'agent', placeKey: 'owner-reach' }, access: {}, reader: { kind: 'owner' } };
const sharedAgent: Caller = { principal: { kind: 'agent', placeKey: `place:${SHARED}`, ownerReach: false }, actor: { type: 'agent', placeKey: `place:${SHARED}` }, access: {}, reader: { kind: 'place' } };
const ownerPhone: Caller = { principal: { kind: 'owner-device', client: 'phone', approvedVia: 'phone' }, actor: { type: 'owner-phone', deviceId: 'od', signedOrigin: { ...so, domain: 'instar-device-v1' } }, access: {}, reader: { kind: 'owner' } };
const mara: Caller = { principal: { kind: 'person', personKey: 'mara', tier: 'member', client: 'phone' }, actor: { type: 'person', personKey: 'mara', deviceId: 'dm', client: 'phone', signedOrigin: so }, access: {}, reader: { kind: 'place' } };
const gus: Caller = { principal: { kind: 'person', personKey: 'gus', tier: 'guest', client: 'phone' }, actor: { type: 'person', personKey: 'gus', deviceId: 'dg', client: 'phone', signedOrigin: so }, access: {}, reader: { kind: 'place' } };
const zed: Caller = { principal: { kind: 'person', personKey: 'zed', tier: 'member', client: 'phone' }, actor: { type: 'person', personKey: 'zed', deviceId: 'dz', client: 'phone', signedOrigin: so }, access: {}, reader: { kind: 'place' } };

const MD = '# Plan\n\nWe ship the viewer in three steps.\n\nThe first step is the core library.\n';

describe('DocumentService', () => {
  it('creates an owner-only document and reads it back exactly', () => {
    const { svc } = setup();
    const { id } = svc.create(bearer, { title: 'Onboarding plan', markdown: MD, primary: OWN });
    const r = svc.read(id, bearer);
    expect(r.title).toBe('Onboarding plan');
    expect(r.markdown).toBe(MD);
    expect(r.version?.label).toBe(1);
  });

  it('refuses an owner-reach caller putting a document into a shared conversation', () => {
    const { svc } = setup();
    expect(() => svc.create(bearer, { title: 'x', markdown: MD, primary: SHARED })).toThrow(DocError);
  });

  it('a shared document: members comment, guests read, strangers get not-found, owner-reach sees metadata only', () => {
    const { svc } = setup();
    const { id, versionId } = svc.create(sharedAgent, { title: 'Shared plan', markdown: MD, primary: SHARED });
    const text = projectText(MD).text;
    const start = text.indexOf('three steps');
    const { key } = svc.comment(id, mara, { onVersion: versionId, start, end: start + 'three steps'.length, body: 'Why three?' });
    expect(svc.read(id, gus).markdown).toBe(MD);
    expect(() => svc.comment(id, gus, { onVersion: versionId, start, end: start + 5, body: 'no' })).toThrow(/unknown-document/);
    expect(() => svc.read(id, zed)).toThrow(/unknown-document/);
    expect(() => svc.read(id, bearer)).toThrow(/unknown-document/);
    expect(svc.metadata(id, bearer).title).toBeNull();
    const list = svc.comments(id, sharedAgent);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key, quote: 'three steps', body: 'Why three?', anchorState: 'ok' });
  });

  it('refuses a comment whose passage is not in the version', () => {
    const { svc } = setup();
    const { id, versionId } = svc.create(sharedAgent, { title: 'Shared', markdown: MD, primary: SHARED });
    expect(() => svc.comment(id, mara, { onVersion: versionId, start: 5, end: 5_000, body: 'x' })).toThrow(/quote-not-in-document/);
  });

  it('keeps a comment on its passage through a revision, and marks a removed passage', () => {
    const { svc } = setup();
    const { id, versionId } = svc.create(sharedAgent, { title: 'Shared', markdown: MD, primary: SHARED });
    const text = projectText(MD).text;
    const s1 = text.indexOf('the core library');
    svc.comment(id, mara, { onVersion: versionId, start: s1, end: s1 + 'the core library'.length, body: 'Which one?' });
    const s2 = text.indexOf('three steps');
    svc.comment(id, mara, { onVersion: versionId, start: s2, end: s2 + 'three steps'.length, body: 'Too many?' });
    svc.revise(id, sharedAgent, { markdown: '# Plan\n\nAn introduction paragraph.\n\nWe ship the viewer soon.\n\nThe first step is the core library.\n' });
    const byBody = Object.fromEntries(svc.comments(id, sharedAgent).map((c) => [c.body, c.anchorState]));
    expect(byBody['Which one?']).toBe('ok');
    expect(byBody['Too many?']).toBe('orphaned');
  });

  it('replies, resolves own comments, records a Send, and compares versions', () => {
    const { svc } = setup();
    const { id, versionId } = svc.create(sharedAgent, { title: 'Shared', markdown: MD, primary: SHARED });
    const text = projectText(MD).text; const s = text.indexOf('three steps');
    const { key } = svc.comment(id, mara, { onVersion: versionId, start: s, end: s + 11, body: 'Why?' });
    svc.reply(id, sharedAgent, key, 'Because of review.');
    expect(svc.recordSend(id, mara, { batchId: `${Date.now()}-${'5'.repeat(8)}-5555-4555-8555-${'5'.repeat(12)}`, messageRequestId: 'r1' }).covered).toHaveLength(1);
    expect(() => svc.resolve(id, gus, key, true)).toThrow(/unknown-document/);
    svc.resolve(id, mara, key, true);
    expect(svc.comments(id, sharedAgent, 'open')).toHaveLength(0);
    expect(svc.comments(id, sharedAgent, 'resolved')[0].replies[0].body).toBe('Because of review.');
    const { versionId: v2 } = svc.revise(id, sharedAgent, { markdown: MD.replace('three', 'two') });
    const diff = svc.compare(id, sharedAgent, versionId, v2);
    expect(diff.ops.some((o) => o.op === 'ins' && o.text.includes('two'))).toBe(true);
  });

  it('only the owner phone may move; members may not revise someone else\'s document', () => {
    const { svc } = setup();
    const { id } = svc.create(sharedAgent, { title: 'Shared', markdown: MD, primary: SHARED });
    expect(() => svc.revise(id, mara, { markdown: 'x' })).toThrow(/unknown-document/);
    expect(svc.revise(id, ownerPhone, { markdown: 'owner edit' }).label).toBe(2);
  });

  it('lists a conversation\'s documents filtered to the caller', () => {
    const { svc } = setup();
    svc.create(sharedAgent, { title: 'A', markdown: MD, primary: SHARED });
    svc.create(bearer, { title: 'Private', markdown: MD, primary: OWN });
    expect(svc.listForConversation(SHARED, mara)).toHaveLength(1);
    expect(svc.listForConversation(OWN, mara)).toHaveLength(0);
    expect(svc.listForConversation(SHARED, bearer)[0].title).toBeNull();
  });
});
