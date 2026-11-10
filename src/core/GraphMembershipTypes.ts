/** Plain shapes only, with no imports, so shared config types can name a graph
 * membership without pulling the graph implementation into their import closure.
 * Spec: docs/specs/conversation-effort-hierarchy-v3.md (membership epochs). */
export interface GraphCustodyProfile {
 v:1;agentId:string;membershipEpoch:number;membershipContextHash:string;
 mode:'owned-machine'|'external';witnessId:string;witnessPublicKey:string;failureDomain:string;
 hostMachineId:string|null;hostSigningPublicKey:string|null;createdAt:string;signature:string;
}
export interface GraphMembershipMember {
  machineId: string;
  signingPublicKey: string;
  sealingPublicKey: string;
}
export interface GraphMembershipEpoch {
  custodyProfile?:GraphCustodyProfile;
  v: 1; agentId: string; epoch: number; previousMembershipHash: string | null;
  members: GraphMembershipMember[]; writerId: string; witnessId: string;
  failureDomain: string; createdAt: string; signature: string;
}
