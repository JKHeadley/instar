import { buildBoundedContext, buildStructuredSha256Identity } from '../../core/JudgmentProvenanceLog.js';

export interface StallAlertDecisionInput {
  promptText: string;
  type: 'stall' | 'promise-expired';
  sessionName: string;
  messageText: string;
  minutesElapsed: number;
  sessionAlive: boolean;
}

/** Identity-only envelope shared by the byte-identical Slack and Telegram prompts. */
export function buildStallAlertDecisionContext(
  input: StallAlertDecisionInput,
): Record<string, unknown> {
  return buildBoundedContext({
    promptIdentitySha256: buildStructuredSha256Identity(input.promptText),
    promptChars: input.promptText.length,
    promptBytes: Buffer.byteLength(input.promptText, 'utf8'),
    alertType: input.type,
    sessionNameIdentitySha256: buildStructuredSha256Identity(input.sessionName),
    sessionNameChars: input.sessionName.length,
    messageIdentitySha256: buildStructuredSha256Identity(input.messageText),
    messageChars: input.messageText.length,
    minutesElapsed: input.minutesElapsed,
    sessionAlive: input.sessionAlive,
  });
}
