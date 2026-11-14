import {describe,it,expect,vi} from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';
import {attachOwnedGraphCustody} from '../../src/core/OwnedGraphCustody.js';
import {createPeerGraphCustodyTransport} from '../../src/core/GraphCustodyTransport.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {canonicalHash,signGraphRecord} from '../../src/core/GraphWitnessTypes.js';
describe('owned custody through the actual authenticated installed-peer channel',()=>{
 it('uses the same verified client and durable engine on the designated enrolled host without an external URL',async()=>{
  const fixture=await setup({ownedCustodyHostIndex:1}),{f,runtime,peer,managers,options,service}=fixture,ownerPublicKey=options[0].configuration!.ownerPublicKey;
  const owned=attachOwnedGraphCustody({service,identity:managers[1],membership:f.membership,ownerPublicKey,bearerToken:'runtime-test-token'});options[1].configuration!.localCustodyTransport=owned.transport;options[1].configuration!.witness=owned.client;
  const transport=createPeerGraphCustodyTransport({membership:f.membership,ownerPublicKey,request:(host,body)=>runtime.requestCustody(host,body)});
  const client=new GraphWitnessClient({agentId:'echo',witnessId:f.membership.witnessId,witnessPublicKey:f.membership.custodyProfile!.witnessPublicKey,expectedFailureDomain:f.membership.failureDomain,ownerPublicKey,bearerToken:'',transport});options[0].configuration!.witness=client;
  expect((await client.inventory(crypto.randomBytes(32).toString('base64url'))).activeMembershipHash).toBe(canonicalHash(f.membership));
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const r=f.record('actual-owned-peer-commit');const result=await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash('actual-owned-peer-commit'),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('private source on an owned host')},token));
  expect(result.state).toBe('committed');const record=runtime.source.lookupByIdempotencyKey(r.packet.idempotencyKey)!;expect(runtime.source.allCommitProofDelivered(record.packet.eventId)).toBe(true);expect(peer.source.status(record.packet.eventId).state).toBe('committed');expect(service.operation('echo',r.packet.idempotencyKey)!.certificate).toEqual(record.certificate);
  const denied=await runtime.requestCustody(peer.machineId,{method:'GET',path:'/v1/agents/some-other-agent/memberships/1'}) as {status:number};expect(denied.status).toBe(403);await expect(runtime.requestCustody(runtime.machineId,{method:'GET',path:'/health'})).rejects.toThrow('target-invalid');
 });
 it('rejects a valid enrolled request at the wrong host and a mismatched local role adapter before execution',async()=>{
  const fixture=await setup({ownedCustodyHostIndex:1}),{f,runtime,peer,managers,options,service,apps}=fixture;
  const owned=attachOwnedGraphCustody({service,identity:managers[1],membership:f.membership,ownerPublicKey:options[0].configuration!.ownerPublicKey,bearerToken:'runtime-test-token'});options[1].configuration!.localCustodyTransport=owned.transport;
  const unsigned={v:1,agentId:'echo',membershipHash:canonicalHash(f.membership),sender:peer.machineId,target:runtime.machineId,action:'custody',requestId:crypto.randomBytes(16).toString('hex'),issuedAt:new Date().toISOString(),body:{method:'GET',path:'/health'}};
  const signed={...unsigned,signature:signGraphRecord('graph-peer-request-v1',unsigned,managers[1].loadSigningKey())};expect((await request(apps[0]).post('/internal/conversation-graph/replicate').set('Authorization','Bearer runtime-peer-auth').send(signed)).status).toBe(409);
  const execute=vi.fn(owned.transport.request.bind(owned.transport));options[1].configuration!.localCustodyTransport={...owned.transport,profileHash:'0'.repeat(64),request:execute};await expect(runtime.requestCustody(peer.machineId,{method:'GET',path:'/health'})).rejects.toThrow();expect(execute).not.toHaveBeenCalled();options[1].configuration!.localCustodyTransport=owned.transport;
 });
});
