import type { SessionOwnershipRegistry } from './SessionOwnershipRegistry.js';

/** A readable missing record means local, as in Topic Profile §5.3.
 * A failed configured read is unknown. Epochs prevent away-and-back reuse.
 */
export function profileProposalPlacement(
  registry: Pick<SessionOwnershipRegistry, 'read'> | null | undefined,
  selfId: string | null | undefined, source: string, target: string,
  configured = false,
): string | null {
  if (!registry) return selfId || configured ? null : 'standalone';
  try {
    const records = [source, target].map(key => {
      const r = registry.read(key);
      if (!r) return { key, epoch: 0, owner: selfId ?? 'local', status: 'absent' };
      if (r.status === 'transferring' || (r.status !== 'released' && r.ownerMachineId !== selfId)) throw new Error('destination-owner');
      return { key, epoch: r.ownershipEpoch, owner: r.ownerMachineId, status: r.status };
    });
    return JSON.stringify(records);
  } catch { return null; /* Unknown placement cannot authorize a proposal. */ }
}
