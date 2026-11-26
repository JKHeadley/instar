import { createHash } from 'node:crypto';
import { PAIRED_COORDINATION_KIND, type createPairedCoordinationPolicy } from './pairedCoordinationPolicy.js';

type Policy = ReturnType<typeof createPairedCoordinationPolicy>;
type Recipient = Parameters<Policy['admitsWorkCoordination']>[0];

/** This lane is supplied only after normal content safety and authenticated route resolution. */
export function createPairedCoordinationDelivery<T>(deps: {
  policy: Pick<Policy, 'admitsWorkCoordination'>;
  /**
   * Dispatch synchronously on the already-authenticated channel bound to this exact key.
   * A queued or retried send must run this adapter again at final transport egress.
   */
  dispatch: (recipient: Recipient, ownedFinalBytes: Buffer, kind: typeof PAIRED_COORDINATION_KIND) => T;
}) {
  return (recipient: Recipient, coordinationId: string, finalBytes: Buffer):
    { kind: 'refused' } | { kind: typeof PAIRED_COORDINATION_KIND; result: T } => {
    const target = Object.freeze({ ...recipient });
    const owned = Buffer.from(finalBytes);
    const messageDigest = createHash('sha256').update(owned).digest('hex');
    if (!deps.policy.admitsWorkCoordination(target, { coordinationId, messageDigest })) return { kind: 'refused' };
    return { kind: PAIRED_COORDINATION_KIND, result: deps.dispatch(target, owned, PAIRED_COORDINATION_KIND) };
  };
}
