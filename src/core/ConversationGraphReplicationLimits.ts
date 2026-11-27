/** Acyclic custody limits shared by intake and durable source. */
export const GRAPH_REPLICATION_MAX_RECORD_BYTES=3*1024*1024;
/** Graph publication is a declared subset of the native lease counter domain.
 * Membership/native mixed-radix positive ranks are <2^50; negative ranks start at2^52 and remain safe integers.
 * Enforced before graph custody ACK; it does not restrict the native lease. */
export const GRAPH_REPLICATION_MEMBERSHIP_BITS=16;
export const GRAPH_REPLICATION_NATIVE_EPOCH_BITS=24;
export const GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH=2**GRAPH_REPLICATION_MEMBERSHIP_BITS;
export const GRAPH_REPLICATION_MAX_LEASE_EPOCH=2**GRAPH_REPLICATION_NATIVE_EPOCH_BITS-1;
export const GRAPH_REPLICATION_NEGATIVE_RANK_BASE=2**52;
export const GRAPH_REPLICATION_EPOCH_STRIDE=1024;

/** Graph resource version, independent of the real native lease policy. A
 * membership transition dominates every rank from the previous membership.
 * Exhaustion holds graph admission; it never clamps or rewrites a counter. */
export function graphReplicationPublicationVersion(membershipEpoch:number,leaseEpoch:number,stage:number,negative=false):number{
 if(!Number.isSafeInteger(membershipEpoch)||membershipEpoch<1||membershipEpoch>GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH||!Number.isSafeInteger(leaseEpoch)||leaseEpoch<1||leaseEpoch>GRAPH_REPLICATION_MAX_LEASE_EPOCH||!Number.isSafeInteger(stage)||stage<0||stage>=GRAPH_REPLICATION_EPOCH_STRIDE)throw new Error('graph-replication-publication-capacity');
 const ordinal=(membershipEpoch-1)*2**GRAPH_REPLICATION_NATIVE_EPOCH_BITS+leaseEpoch;
 const version=(negative?GRAPH_REPLICATION_NEGATIVE_RANK_BASE:0)+ordinal*GRAPH_REPLICATION_EPOCH_STRIDE+stage;
 if(!Number.isSafeInteger(version))throw new Error('graph-replication-publication-version-overflow');return version;
}
export function validGraphReplicationPublicationVersion(value:unknown):value is number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<GRAPH_REPLICATION_EPOCH_STRIDE)return false;
 const rank=value>=GRAPH_REPLICATION_NEGATIVE_RANK_BASE?value-GRAPH_REPLICATION_NEGATIVE_RANK_BASE:value;
 if(rank>=2**50)return false;const ordinal=Math.floor(rank/GRAPH_REPLICATION_EPOCH_STRIDE),native=ordinal%2**GRAPH_REPLICATION_NATIVE_EPOCH_BITS;
 return native>=1&&native<=GRAPH_REPLICATION_MAX_LEASE_EPOCH&&Math.floor(ordinal/2**GRAPH_REPLICATION_NATIVE_EPOCH_BITS)<GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH;
}
