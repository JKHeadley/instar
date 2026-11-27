import {describe,it,expect,vi} from 'vitest';
import {setupHeldGraphSourceFixture} from '../helpers/conversation-graph-held-source.js';
import {GraphRecoverySourceManifestAccumulator} from '../../src/core/ConversationGraphRecoveryManifest.js';
import {canonicalHash,signGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D,verifyMembershipTransferReceipt} from '../../src/core/GraphWitnessTypes.js';
// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});

describe('actual prepared row cleanup ordering',()=>{
 it('finishes prior detached envelope cleanup before reading the next verified Source row',async()=>{
  const f=await setupHeldGraphSourceFixture({sourceCount:2}),context={authority:f.authorities[0],hold:{kind:'planned' as const,intent:f.intent,nativeFloor:f.nativeFloor,lease:f.native.lease,originalLease:f.native.originalLease}},prepared=await f.runtime.transfer.prepareHeldRewrapInventory({recoveryId:'prepared-two-row-lifetime',source:f.sourceReader,context,newMembership:f.newMembership,coordinator:f.options[0].leaseCoordinator});
  try{
   const accumulator=new GraphRecoverySourceManifestAccumulator(f.previousMembership);for(const descriptor of f.sourceReader.descriptors()){const record=await f.sourceReader.readRecord(descriptor.eventId);accumulator.append(record);f.sourceReader.releasePrivateViews();}const manifest=accumulator.finish(),rawLease={...unsigned(f.native.lease),membershipEpoch:f.newMembership.epoch},lease={...rawLease,signature:signGraphRecord(D.lease,rawLease,f.managers[0].loadSigningKey())},raw={v:1 as const,agentId:'echo',recoveryId:'prepared-two-row-lifetime',previousMembershipHash:canonicalHash(f.previousMembership),newMembershipHash:canonicalHash(f.newMembership),previousWitnessId:f.previousMembership.witnessId,newWitnessId:f.newMembership.witnessId,fenceEpoch:lease.leaseEpoch,highestCertifiedSequence:manifest.highestCertifiedSequence,highestCertifiedCoreHash:manifest.highestCertifiedCoreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:canonicalHash(prepared.inventory()),issuedAt:new Date().toISOString()},authorization={...raw,signature:signGraphRecord(D.recovery,raw,f.f.owner.privateKey)},metadata={authorization,previousMembership:f.previousMembership,newMembership:f.newMembership,currentLease:lease,originalCurrentLease:f.native.originalLease,manifest,revalidations:[]};
   const detached:Array<NonNullable<Awaited<ReturnType<ReturnType<typeof prepared.envelopes>['next']>>['value']>['rewrap']>=[];
   async function* envelopes(){for await(const item of prepared.envelopes()){if(detached.length)expect(JSON.stringify(detached[detached.length-1])).not.toContain('ciphertext');detached.push(item.rewrap);yield item;}}
   const receipt=await f.runtime.transfer.stageHeldSource(metadata,f.sourceReader,context,envelopes());expect(verifyMembershipTransferReceipt(receipt,authorization,f.newMembership)).toBe(true);expect(detached).toHaveLength(2);for(const wrapper of detached)expect(JSON.stringify(wrapper)).not.toContain('ciphertext');f.sourceReader.assertFinalized();
  }finally{prepared.close();f.sourceReader.close();}
 });
});
