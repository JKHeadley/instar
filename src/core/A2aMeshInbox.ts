import type { MeshCommand } from './MeshRpc.js';
import { parseMarker } from '../messaging/AgentTelegramComms.js';

export type A2aInboxDeliverCommand = Extract<MeshCommand, { type: 'a2a-inbox-deliver' }>;

export interface A2aMeshInboxDeps {
  localAgent: string;
  authenticatedSenderMachine: string;
  authorizedMentorMachine: (agent: string) => string | undefined;
  dispatch?: (message: {
    text: string;
    topicId: number;
    senderIsBot: true;
    senderBotId: string;
  }) => Promise<boolean>;
}

/**
 * Recipient-side adapter from authenticated MeshRpc into the existing A2A
 * accept boundary. Machine authentication grants reach only; the downstream
 * marker parser and known-mentor role/bot-id allowlist retain content authority.
 */
export async function handleA2aMeshInbox(
  command: A2aInboxDeliverCommand,
  deps: A2aMeshInboxDeps,
): Promise<{ ok: boolean; agentMessage: boolean; reason?: string }> {
  if (command.targetAgent !== deps.localAgent) {
    return { ok: false, agentMessage: false, reason: 'wrong-target-agent' };
  }
  const expectedMachine = deps.authorizedMentorMachine(command.senderAgent);
  if (!expectedMachine || expectedMachine !== deps.authenticatedSenderMachine) {
    return { ok: false, agentMessage: false, reason: 'sender-machine-unauthorized' };
  }
  if (!deps.dispatch) return { ok: false, agentMessage: false, reason: 'no-adapter' };
  if (!Number.isFinite(command.topicId) || !command.text || !command.senderBotId) {
    return { ok: false, agentMessage: false, reason: 'invalid-payload' };
  }
  const parsed = parseMarker(command.text);
  if (!parsed.ok || parsed.msg.from !== command.senderAgent || parsed.msg.to !== command.targetAgent) {
    return { ok: false, agentMessage: false, reason: 'marker-principal-mismatch' };
  }
  const agentMessage = await deps.dispatch({
    text: command.text,
    topicId: command.topicId,
    senderIsBot: true,
    senderBotId: command.senderBotId,
  });
  return agentMessage
    ? { ok: true, agentMessage: true }
    : { ok: false, agentMessage: false, reason: 'not-routed' };
}
