/**
 * CliApprovalChannel — F-5 stub implementation of the local-CLI-backed
 * `TrustedApprovalChannel`. The real verification (signed local CLI
 * confirmation via `instar doctor confirm-unquarantine <runbookId>
 * <challenge-token>`, signed with the agent's locally-stored
 * doctor-confirmation key) is a Tier-2 follow-up that wires into the
 * doctor command surface.
 *
 * This stub exposes the channel SHAPE so the trust-elevation source can
 * compose against the real implementation without depending on it. The
 * stub's `verifyApproval` is deterministic: it returns whatever was
 * seeded via the constructor's `seededConfirmations` map, keyed by a
 * stable `(runbookId, action, challengeToken)` tuple.
 *
 * Spec anchors: A53 (essential-runbook un-quarantine real second factor —
 * option 1: signed CLI confirmation), A59 (channel-abstraction contract).
 */

import type {
  TrustedApprovalChannel,
  TrustedApprovalVerifyInput,
  TrustedApprovalVerifyResult,
} from '../TrustElevationSource.js';

export interface CliApprovalSeed {
  approved: boolean;
  principalUserId?: string;
}

export interface CliApprovalChannelOpts {
  /** Optional seeded confirmations for test fixtures. Real CLI signing comes later. */
  seededConfirmations?: Map<string, CliApprovalSeed>;
  /** Principal identifier (local operator). */
  principalUserId?: string;
}

export class CliApprovalChannel implements TrustedApprovalChannel {
  public readonly name = 'cli-doctor';
  public readonly kind = 'cli';

  private readonly seededConfirmations: Map<string, CliApprovalSeed>;
  private readonly principalUserId?: string;

  constructor(opts: CliApprovalChannelOpts = {}) {
    this.seededConfirmations = opts.seededConfirmations ?? new Map();
    this.principalUserId = opts.principalUserId;
  }

  async verifyApproval(
    input: TrustedApprovalVerifyInput,
  ): Promise<TrustedApprovalVerifyResult> {
    const key = approvalKey(input);
    const seed = this.seededConfirmations.get(key);
    if (!seed) {
      return { approved: false, reason: 'no-matching-cli-confirmation' };
    }
    return {
      approved: seed.approved,
      principalUserId: seed.principalUserId ?? this.principalUserId,
      reason: seed.approved ? 'cli-confirmation-verified' : 'cli-confirmation-rejected',
    };
  }
}

function approvalKey(input: TrustedApprovalVerifyInput): string {
  const scope = input.runbookId ?? input.proposalId ?? '';
  const msg = input.messageId ?? '';
  return `${scope}::${input.action}::${msg}`;
}
