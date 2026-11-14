/** Instar Documents sync: pages by vector, purges first, blobs only when a held row names them (§5.1). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService, type Caller } from '../../src/documents/service.js';
import { DocumentPuller, applySyncPage, buildSyncPage } from '../../src/documents/sync.js';
import type { TeamView } from '../../src/documents/access.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/documents-sync.test.ts' }); });

const OWN = 'app:55555555-5555-4555-8555-555555555555';
const team: TeamView = { personMay: () => false, ownerOnly: () => true, sessionInPlace: () => false, teamRefusal: () => null, sendReachesOwner: () => false };
const bearer: Caller = { principal: { kind: 'bearer' }, actor: { type: 'agent', placeKey: 'owner-reach' }, access: {}, reader: { kind: 'owner' } };
const ownerPhone: Caller = { principal: { kind: 'owner-device', client: 'phone', approvedVia: 'phone' }, actor: { type: 'owner-phone', deviceId: 'od', signedOrigin: { keyHash: 'k', deviceId: 'od', domain: 'instar-device-v1', payloadB64: 'e30', host: 'h', timeMs: '1', sig: 's' } }, access: {}, reader: { kind: 'owner' } };

function machines() {
  const pems = new Map<string, string>();
  const lookup: MachineKeyLookup = (id) => (pems.has(id) ? { status: 'ok', publicKeyPem: pems.get(id)! } : { status: 'unknown' });
  const make = (id: string) => {
    const kp = generateSigningKeyPair(); pems.set(id, kp.publicKey);
    const signer: MachineSigner = { machineId: () => id, signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: id, signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `docsync-${id}-`)); tmp.push(dir);
    const store = new DocumentStore(dir, { signer, keyLookup: lookup, standing: () => 'ok' });
    return { store, svc: new DocumentService(store, team) };
  };
  return { A: make('A'), B: make('B') };
}

describe('document sync', () => {
  it('a document written on A reads identically on B after one pull', async () => {
    const { A, B } = machines();
    const md = '# Plan\n\n' + 'A paragraph of the plan. '.repeat(3000) + '\n\nThe end.\n';
    const { id } = A.svc.create(bearer, { title: 'Big plan', markdown: md, primary: OWN });
    const puller = new DocumentPuller(() => B.store, () => [{ machineId: 'A', fetchPage: async (have) => JSON.parse(JSON.stringify(buildSyncPage(A.store, have))) }]);
    await puller.tick();
    expect(B.svc.read(id, bearer).markdown).toBe(md);
    expect(puller.health()).toEqual({});
  });

  it('pages by bytes and catches up over several pages', async () => {
    const { A, B } = machines();
    for (let i = 0; i < 5; i++) A.svc.create(bearer, { title: `Doc ${i}`, markdown: `# ${i}\n\nText ${i}.\n`, primary: OWN });
    const puller = new DocumentPuller(() => B.store, () => [{ machineId: 'A', fetchPage: async (have) => JSON.parse(JSON.stringify(buildSyncPage(A.store, have, 6_000))) }]);
    await puller.tick();
    expect(B.store.have()).toEqual(A.store.have());
  });

  it('a purge travels first: the receiver refuses that document\'s text afterwards', () => {
    const { A, B } = machines();
    const { id } = A.svc.create(bearer, { title: 'Secret', markdown: '# Secret\n\nDo not keep.\n', primary: OWN });
    const early = JSON.parse(JSON.stringify(buildSyncPage(A.store, {})));
    const created = A.store.rowsOf(id).find((r) => r.eventKind === 'created')!;
    A.store.append(id, { eventKind: 'purge' }, { actor: ownerPhone.actor, access: {}, primaryRow: `${created.origin}/${created.incarnation}#${created.seq}` });
    // B first receives a page with the purge, then a stale page that still carries the text.
    applySyncPage(B.store, JSON.parse(JSON.stringify(buildSyncPage(A.store, {}))));
    const res = applySyncPage(B.store, early);
    expect(res.blobs).toBe(0);
    expect(B.store.isPurged(id)).toBe(true);
  });

  it('refuses a blob no held row names, and counts a peer that fails', async () => {
    const { A, B } = machines();
    A.svc.create(bearer, { title: 'x', markdown: '# x\n', primary: OWN });
    const page = JSON.parse(JSON.stringify(buildSyncPage(A.store, {})));
    page.rows = [];
    expect(applySyncPage(B.store, page).blobs).toBe(0);
    const puller = new DocumentPuller(() => B.store, () => [{ machineId: 'A', fetchPage: async () => { throw new Error('offline'); } }]);
    await puller.tick();
    expect(puller.health().A.count).toBe(1);
  });
});

describe('document sync after review', () => {
  it('a large version arrives whole even with a tight page budget (rows never outrun their text)', async () => {
    const { A, B } = machines();
    const md = '# Big\n\n' + Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(40)}`).join('\n\n') + '\n';
    const { id } = A.svc.create(bearer, { title: 'Big', markdown: md, primary: OWN });
    const puller = new DocumentPuller(() => B.store, () => [{ machineId: 'A', fetchPage: async (have) => JSON.parse(JSON.stringify(buildSyncPage(A.store, have, 64 * 1024))) }], 200);
    await puller.tick();
    expect(B.svc.read(id, bearer).markdown).toBe(md);
  });
});
