/** Local held-inventory resource policy, not native or protocol capacity.
 * Refusal leaves original custody intact; larger inventories need streaming. */
export const GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES=64*1024*1024;
export function graphMemberLossSnapshotBudget(value:number|undefined):number{
 const limit=value??GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES;
 if(!Number.isSafeInteger(limit)||limit<1||limit>GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES)throw new Error('graph-member-loss-snapshot-budget-invalid');
 return limit;
}
