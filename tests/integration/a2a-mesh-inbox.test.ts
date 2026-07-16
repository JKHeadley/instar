import { describe, expect, it, vi } from 'vitest';
import { handleA2aMeshInbox } from '../../src/core/A2aMeshInbox.js';

describe('authenticated mesh → existing A2A inbox integration', () => {
  const command = {
    type: 'a2a-inbox-deliver' as const,
    targetAgent: 'instar-codey',
    text: '[a2a:from=echo to=instar-codey role=mentor id=m1 corr=c1 ts=1 v=1]\n\nDrive task',
    topicId: 458,
    senderAgent: 'echo',
    senderBotId: 'mentor-bot-id',
  };

  it('passes authenticated reach into the existing marker/allowlist dispatcher', async () => {
    const dispatch = vi.fn(async (message) => message.senderBotId === 'mentor-bot-id');
    await expect(handleA2aMeshInbox(command, { localAgent: 'instar-codey', authenticatedSenderMachine: 'echo-mac', authorizedMentorMachine: () => 'echo-mac', dispatch })).resolves.toEqual({ ok: true, agentMessage: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ senderIsBot: true, topicId: 458, senderBotId: 'mentor-bot-id' }));
  });

  it('fails closed on wrong recipient or downstream allowlist refusal', async () => {
    const dispatch = vi.fn(async () => false);
    const auth = { authenticatedSenderMachine: 'echo-mac', authorizedMentorMachine: () => 'echo-mac' };
    await expect(handleA2aMeshInbox(command, { localAgent: 'other', ...auth, dispatch })).resolves.toMatchObject({ ok: false, reason: 'wrong-target-agent' });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(handleA2aMeshInbox(command, { localAgent: 'instar-codey', ...auth, dispatch })).resolves.toMatchObject({ ok: false, agentMessage: false, reason: 'not-routed' });
    await expect(handleA2aMeshInbox(command, { localAgent: 'instar-codey', authenticatedSenderMachine: 'rogue', authorizedMentorMachine: () => 'echo-mac', dispatch })).resolves.toMatchObject({ ok: false, reason: 'sender-machine-unauthorized' });
  });

  it('binds the authenticated command principal to both marker principals', async () => {
    const dispatch = vi.fn(async () => true);
    const deps = { localAgent: 'instar-codey', authenticatedSenderMachine: 'echo-mac', authorizedMentorMachine: () => 'echo-mac', dispatch };
    await expect(handleA2aMeshInbox({ ...command, text: command.text.replace('from=echo', 'from=other') }, deps)).resolves.toMatchObject({ ok: false, reason: 'marker-principal-mismatch' });
    await expect(handleA2aMeshInbox({ ...command, text: command.text.replace('to=instar-codey', 'to=other') }, deps)).resolves.toMatchObject({ ok: false, reason: 'marker-principal-mismatch' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
