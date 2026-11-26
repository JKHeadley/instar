/** Estimate destination allocation from private worker metadata. Volume
 * measurement, policy calibration and ledger custody belong to the caller. */
export interface LocalHistoryPhysicalPolicy {
  readonly blockBytes: number;
  readonly perWriteMetadataBytes: number;
  readonly maxReservationBytes: number;
  readonly maxAttachments: number;
}

export function estimateLocalHistoryPhysicalBytes(input: unknown, policy: LocalHistoryPhysicalPolicy): number {
  const refuse = (): never => { throw new Error('local-history-physical-budget'); };
  const nonnegative = (number: unknown): number => {
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return refuse();
    return number;
  };
  const block = nonnegative(policy.blockBytes), limit = nonnegative(policy.maxReservationBytes);
  const maxAttachments = nonnegative(policy.maxAttachments);
  if (!block || !limit || !input || typeof input !== 'object' || Array.isArray(input)) return refuse();
  let total = 0;
  const charge = (bytes: unknown, extraBlocks = 0, passes = 1) => {
    const size = nonnegative(bytes);
    if (!size) return;
    const charge = (Math.ceil(size / block) + extraBlocks) * block * passes;
    const next = total + charge;
    if (!Number.isSafeInteger(next) || next > limit) refuse();
    total = next;
  };
  charge(policy.perWriteMetadataBytes);
  const row = input as Record<string, unknown>;
  switch (row.kind) {
    case 'conversation':
      if (Object.keys(row).length !== 3 || !Array.isArray(row.attachmentBytes)
        || row.attachmentBytes.length > maxAttachments) return refuse();
      // An unaligned append can touch a partial preexisting block.
      charge(row.appendBytes, 1);
      for (const bytes of row.attachmentBytes) charge(bytes);
      break;
    case 'manifest':
      if (Object.keys(row).length !== 2) return refuse();
      charge(row.replacementBytes);
      break;
    case 'source-claim':
      if (Object.keys(row).length !== 3) return refuse();
      // Budget a full database write on the forward and rollback paths.
      charge(row.databaseCeilingBytes, 0, 2);
      charge(row.journalBytes);
      break;
    default:
      return refuse();
  }
  return total;
}
