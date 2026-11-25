/** Exact finite-slip action line for the existing owner-device presence envelope. */
export function workBoardSlipApprovalLine(slipId: unknown, disclosureDigest: unknown, actionBindingDigest: unknown): string | null {
  if (typeof slipId !== 'string' || slipId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(slipId)) return null;
  const digest = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
  if (!digest(disclosureDigest) || !digest(actionBindingDigest)) return null;
  return `work-board-slip-approve:v1 ${slipId} ${disclosureDigest} ${actionBindingDigest}`;
}
