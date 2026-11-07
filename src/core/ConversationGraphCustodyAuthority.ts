/** Historical witness roles require completed activation, not a proposed
 * owner-signed roster. Original acceptance membership remains immutable. */
import type crypto from 'node:crypto';
import {canonicalHash,verifyMembershipEpoch,verifyMembershipActivation,
 type GraphWitnessErasedControlProof,type GraphMembershipEpoch,type GraphMembershipActivationCertificate} from './GraphWitnessTypes.js';
export function verifyGraphCustodyAuthority(proof:GraphWitnessErasedControlProof,originalMembership:GraphMembershipEpoch,
 custodyMembership:GraphMembershipEpoch,activations:GraphMembershipActivationCertificate[]|undefined,
 trust:{ownerPublicKey:crypto.KeyLike;witnessPublicKeys:ReadonlyMap<string,crypto.KeyLike>}):boolean {
 try{
  if(!verifyMembershipEpoch(originalMembership,trust.ownerPublicKey)||!verifyMembershipEpoch(custodyMembership,trust.ownerPublicKey)
   ||originalMembership.agentId!==proof.agentId||custodyMembership.agentId!==proof.agentId
   ||custodyMembership.epoch!==proof.custodyMembershipEpoch||custodyMembership.witnessId!==proof.witnessId)return false;
  if(canonicalHash(custodyMembership)===canonicalHash(originalMembership))return !activations?.length;
  if(!Array.isArray(activations)||!activations.length||activations.length>128||custodyMembership.epoch-originalMembership.epoch!==activations.length)return false;
  let previous=originalMembership;
  for(const activation of activations){const key=trust.witnessPublicKeys.get(activation.witnessId);
   if(!key||!verifyMembershipActivation(activation,trust.ownerPublicKey,key)||activation.agentId!==proof.agentId
    ||canonicalHash(activation.previousMembership)!==canonicalHash(previous)||activation.newMembership.epoch!==previous.epoch+1)return false;
   previous=activation.newMembership;
  }return canonicalHash(previous)===canonicalHash(custodyMembership);
 }catch { /* @silent-fallback-ok: malformed historical activation evidence fails verification, never grants proposed custody role */ return false; }
}
