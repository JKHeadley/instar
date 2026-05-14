/**
 * TelegramApprovalChannel — F-5 stub implementation of the Telegram-backed
 * `TrustedApprovalChannel`. The real Telegram-countersignature verification
 * (A22 option 2 / A25 / A41 binding-payload + user_id principal + replay
 * watermark) is a Tier-2 follow-up that wires into the actual Telegram
 * relay pipeline.
 *
 * This stub exposes the channel SHAPE so the trust-elevation source can
 * compose against the real implementation without depending on it. The
 * stub's `verifyApproval` is deterministic: it returns whatever was seeded
 * via the constructor's `seededApprovals` map, keyed by a stable
 * `(proposalId | runbookId, action, messageId)` tuple.
 *
 * Spec anchors: A22 (different-principal commit), A25 (un-quarantine via
 * authenticated endpoint), A41 (Telegram countersignature payload binding +
 * user_id principal + replay watermark), A59 (channel-abstraction contract).
 */

import type {
  TrustedApprovalChannel,
  TrustedApprovalVerifyInput,
  TrustedApprovalVerifyResult,
} from '../TrustElevationSource.js';

export interface TelegramApprovalSeed {
  approved: boolean;
  principalUserId?: string;
}

export interface TelegramApprovalChannelOpts {
  /** Optional seeded approvals for test fixtures. Real Telegram comes later. */
  seededApprovals?: Map<string, TelegramApprovalSeed>;
  /** Principal user_id (set during `instar init` per A41). */
  principalUserId?: string;
}

export class TelegramApprovalChannel implements TrustedApprovalChannel {
  public readonly name = 'telegram';
  public readonly kind = 'telegram';

  private readonly seededApprovals: Map<string, TelegramApprovalSeed>;
  private readonly principalUserId?: string;

  constructor(opts: TelegramApprovalChannelOpts = {}) {
    this.seededApprovals = opts.seededApprovals ?? new Map();
    this.principalUserId = opts.principalUserId;
  }

  async verifyApproval(
    input: TrustedApprovalVerifyInput,
  ): Promise<TrustedApprovalVerifyResult> {
    const key = approvalKey(input);
    const seed = this.seededApprovals.get(key);
    if (!seed) {
      return { approved: false, reason: 'no-matching-telegram-countersignature' };
    }
    return {
      approved: seed.approved,
      principalUserId: seed.principalUserId ?? this.principalUserId,
      reason: seed.approved ? 'telegram-countersignature-verified' : 'telegram-countersignature-rejected',
    };
  }
}

function approvalKey(input: TrustedApprovalVerifyInput): string {
  const scope = input.runbookId ?? input.proposalId ?? '';
  const msg = input.messageId ?? '';
  return `${scope}::${input.action}::${msg}`;
}
