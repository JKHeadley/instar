import type { ProfileProposalRequests, ProposalReply } from './ProfileProposalRequests.js';
import type { TopicProfileWriteSurface } from './topicProfileWriteSurface.js';

/** Called only after platform sender authentication. No HTTP body supplies this principal. */
export function handleProfileProposalReply(input: {
  requests: ProfileProposalRequests;
  surface: TopicProfileWriteSurface;
  source: string;
  text: string;
  messageId: number;
  replyTo: number;
  forwarded: boolean;
  principal: { kind: 'operator'; platform: string; uid: string };
  eligible: (target: string) => boolean;
  placement: (target: string) => string | null;
  name: (target: string) => string;
}): Promise<ProposalReply> {
  return input.requests.reply(input.source, input, async proposal => {
    const eligible = () => input.eligible(proposal.target)
      && input.placement(proposal.target) === proposal.contextStamp;
    if (!eligible()) return { ok: false,
      reply: 'I did not make that change. I need to prepare a fresh question in the destination conversation.',
      refusal: { reason: 'proposal-eligibility-changed' } };
    return input.surface.applyWrite({
      topicKey: proposal.target, patch: proposal.patch, principal: input.principal,
      origin: 'propose-confirm', agentComposedPayload: true, discloseInReply: true,
      ...(proposal.target !== input.source ? { crossTopicConfirm: { sourceTopicId: Number(input.source) } } : {}),
      confirmation: { echo: proposal.core, name: input.name(proposal.target), eligible,
        validAtCommit: () => input.requests.validAtCommit(proposal) },
    });
  });
}

/** The production consumer keeps delivery failure outside the committed-result cache. */
export async function handleAndAcknowledgeProfileProposalReply(
  input: Parameters<typeof handleProfileProposalReply>[0],
  acknowledge: (text: string) => Promise<unknown>,
): Promise<ProposalReply & { acknowledgment: 'delivered' | 'failed' | 'not-needed' }> {
  const outcome = await handleProfileProposalReply(input);
  if (!outcome.matched || !outcome.result) return { ...outcome, acknowledgment: 'not-needed' };
  try {
    await acknowledge(outcome.result.reply);
    return { ...outcome, acknowledgment: 'delivered' };
  } catch {
    // A delivery failure must not reject/replace the already committed result.
    return { ...outcome, acknowledgment: 'failed' };
  }
}
