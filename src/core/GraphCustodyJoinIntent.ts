/** What counts as adding one machine: everything the existing members signed stays exactly
 * as it was, and the only difference is one new row. A join can never remove, swap or re-key
 * a member, or move the host or witness. Signatures are checked by the caller. */
import {canonicalHash,type GraphMembershipEpoch,type GraphMembershipMember} from './GraphWitnessTypes.js';

export function graphJoinAddition(previous:GraphMembershipEpoch,next:GraphMembershipEpoch):GraphMembershipMember|null{
 if(next.epoch!==previous.epoch+1||next.agentId!==previous.agentId||next.previousMembershipHash!==canonicalHash(previous)||next.witnessId!==previous.witnessId||next.failureDomain!==previous.failureDomain||next.writerId!==previous.writerId||next.v!==previous.v)return null;
 const before=previous.custodyProfile,after=next.custodyProfile;
 if(before?.mode!=='owned-machine'||after?.mode!=='owned-machine'||before.hostMachineId!==after.hostMachineId||before.witnessPublicKey!==after.witnessPublicKey||before.hostSigningPublicKey!==after.hostSigningPublicKey||before.failureDomain!==after.failureDomain)return null;
 if(next.members.length!==previous.members.length+1)return null;
 const prior=new Map(previous.members.map(member=>[member.machineId,canonicalHash(member)]));
 const added=next.members.filter(member=>!prior.has(member.machineId));
 if(added.length!==1||new Set(next.members.map(member=>member.machineId)).size!==next.members.length)return null;
 for(const member of next.members)if(member!==added[0]&&prior.get(member.machineId)!==canonicalHash(member))return null;
 return added[0];
}
