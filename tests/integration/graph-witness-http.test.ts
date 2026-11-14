import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createGraphWitnessServer } from '../../src/server/graphWitnessServer.js';
import { GraphWitnessClient } from '../../src/core/GraphWitnessClient.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { canonicalHash,signGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D } from '../../src/core/GraphWitnessTypes.js';
import { pem, witnessFixture } from '../unit/graph-witness-fixtures.js';

const servers: Server[] = []; const services: GraphWitnessService[] = []; const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0)) SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'graph-witness-http-fixture-cleanup' });
});
async function boot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-witness-http-')); directories.push(directory);
  const f = witnessFixture(directory); const { app, service } = createGraphWitnessServer(f.options); service.registerMembership(f.membership); services.push(service);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test-listener-unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const options = { baseUrl, agentId: f.membership.agentId, bearerToken: 'test-agent-token', witnessId: f.membership.witnessId,
    ownerPublicKey: pem(f.owner.publicKey),
    witnessPublicKey: pem(f.witness.publicKey), expectedFailureDomain: f.membership.failureDomain, allowLoopbackHttpForTests: true };
  return { ...f, service, baseUrl, options, client: new GraphWitnessClient(options) };
}
describe('managed graph witness HTTP', () => {
  it('runs encrypted prepare, real all-member commit, recovery and certificate persistence through the HTTP client', async () => {
    const f = await boot(); const r = f.prepareRequest();
    await f.client.verifyRemote(); await f.client.registerMembership(f.membership);
    await f.client.prepare(r);
    expect((await f.client.operation(r.packet.idempotencyKey)).state).toBe('prepared');
    await expect(f.client.commit(r, f.membership, [f.receipt(r.packet, 0)])).rejects.toThrow('all-member-durable-receipts-required');
    const cert = await f.client.commit(r, f.membership, [f.receipt(r.packet, 0), f.receipt(r.packet, 1)]);
    expect((await f.client.recover(r.packet.idempotencyKey)).encryptedSourceBundle).toEqual(r.encryptedSourceBundle);
    expect((await f.client.acknowledgeCertificate(r.packet.idempotencyKey, f.receipt(r.packet, 0, 'certificate', canonicalHash(cert)))).allMembersPersisted).toBe(false);
    expect((await f.client.acknowledgeCertificate(r.packet.idempotencyKey, f.receipt(r.packet, 1, 'certificate', canonicalHash(cert)))).allMembersPersisted).toBe(true);
  });
  it('requires exact per-agent transport identity AND cryptographic operation authorization', async () => {
    const f = await boot(); const r = f.prepareRequest();
    const unauthorized = await fetch(`${f.baseUrl}/v1/agents/agent-a/pending`);
    expect(unauthorized.status).toBe(401);
    const other = new GraphWitnessClient({ ...f.options, agentId: 'agent-b' });
    await expect(other.operation(r.packet.idempotencyKey)).rejects.toThrow('witness-auth-required');
    await expect(f.client.prepare({ ...r, packetSignature: '' })).rejects.toThrow('operation-signature-invalid');
    expect(f.service.pending(r.packet.agentId)).toHaveLength(0);
    const wrongPin = new GraphWitnessClient({ ...f.options, witnessPublicKey: pem(f.owner.publicKey) });
    await expect(wrongPin.verifyRemote()).rejects.toThrow('witness-identity-mismatch');
    expect(() => new GraphWitnessClient({ ...f.options, allowLoopbackHttpForTests: false })).toThrow('witness-https-required');
  });
  it('fences cancellation and erasure using exact signed actions and exposes physical-purge limits', async () => {
    const f = await boot(); const r = f.prepareRequest(); await f.client.prepare(r);
    await expect(f.client.cancel(r.packet.idempotencyKey, r.lease, r.originalLease, '')).rejects.toThrow('cancel-signature-invalid');
    const authorizationReceiptHash = canonicalHash({ owner: 'verified' });
    const fields = {target:r.packet.erasureIdentity, requestId: 'erase-0001', bundleHashes: [r.packet.sourceBundleHash], authorizationReceiptHash };
    await f.client.erase(fields.requestId,fields.target, fields.bundleHashes, authorizationReceiptHash, r.lease, r.originalLease, f.actionSignature('erase', fields, r.lease));
    expect((await f.client.recover(r.packet.idempotencyKey)).encryptedSourceBundle).toBeNull();
    expect(await f.client.checkpointErasure(fields.requestId)).toMatchObject({ walPurged: true, externalBackupsVerified: false });
    await expect(f.client.prepare(r)).rejects.toThrow('source-erased');
  });
  it('admits exact erased control before source preparation and advances only via terminal receipts, never source acknowledgments',async()=>{
    const f=await boot(),r=f.prepareRequest(),{encryptedSourceBundle:_neverSent,...control}=r;
    await expect(f.client.admitErasedControl(control)).rejects.toThrow('logical-erasure-required');
    const fields={requestId:'erase-before-prepare',target:r.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'forget'})};
    await f.client.erase(fields.requestId,fields.target,[],fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));
    const operation=await f.client.admitErasedControl(control);expect(operation.state).toBe('erased');expect(operation.prepareProof).toBeNull();expect(operation.erasedControlProof?.operationHash).toBe(canonicalHash(r.packet));await expect(f.client.prepare(r)).rejects.toThrow('source-erased');expect(operation.certificate).toBeNull();expect((await f.client.recover(r.packet.idempotencyKey)).encryptedSourceBundle).toBeNull();
    expect(await f.client.admitErasedControl(control)).toMatchObject({packet:r.packet,controlCapsule:r.controlCapsule,state:'erased'});
    await expect(f.client.certifyCancellation(r,f.membership,[f.receipt(r.packet,0),f.receipt(r.packet,1)])).rejects.toThrow('all-member-terminal-receipts-required');
    const terminal=await f.client.certifyCancellation(control,f.membership,[0,1].map(index=>f.receipt(r.packet,index,'cancellation',canonicalHash(operation.erasure))));expect(terminal.outcome).toBe('erased');
    const next=f.prepareRequest('next-operation',2,r.packet.coreHash);await f.client.prepare(next);expect((await f.client.operation(next.packet.idempotencyKey)).state).toBe('prepared');
    const committed=await f.client.commit(next,f.membership,[f.receipt(next.packet,0),f.receipt(next.packet,1)]);
    expect((await f.client.admitErasedControl((({encryptedSourceBundle,...rest})=>rest)(next))).certificate).toEqual(committed);
  });
  it('never treats unsigned physical-purge or provider booleans as fleet completion authority',async()=>{
    const f=await boot(),r=f.prepareRequest();await f.client.prepare(r);const fields={requestId:'erase-checkpoint-authority',target:r.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'forget'})};await f.client.erase(fields.requestId,fields.target,[],fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));
    const real=await f.client.checkpointErasure(fields.requestId);expect(real.walPurged).toBe(true);const realFetch=globalThis.fetch;
    vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>String(input).endsWith('/checkpoint')?new Response(JSON.stringify({...real,walPurged:true,localPurgeReceipt:null,externalBackupsVerified:true,backupAttestation:null}),{status:200,headers:{'Content-Type':'application/json'}}):realFetch(input,init));
    expect(await f.client.checkpointErasure(fields.requestId)).toMatchObject({walPurged:false,externalBackupsVerified:false});
  });
  it('rejects a witness-signed state carrying a replacement signature rather than the original historical writer signature',async()=>{
    const f=await boot(),request=f.prepareRequest();await f.client.registerMembership(f.membership);await f.client.prepare(request);
    const operation=await f.client.operation(request.packet.idempotencyKey);operation.packetSignature='A'.repeat(86);
    const state={...unsigned(operation.stateProof),packetSignatureHash:canonicalHash(operation.packetSignature)};
    operation.stateProof={...state,signature:signGraphRecord(D.operationState,state,f.witness.privateKey)};
    const realFetch=globalThis.fetch;vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
      if(String(input).includes(`/operations/${encodeURIComponent(request.packet.idempotencyKey)}`))return new Response(JSON.stringify(operation),{status:200,headers:{'Content-Type':'application/json'}});
      return realFetch(input,init);
    });
    await expect(f.client.operation(request.packet.idempotencyKey)).rejects.toThrow('witness-operation-packet-signature-invalid');
  });

});
