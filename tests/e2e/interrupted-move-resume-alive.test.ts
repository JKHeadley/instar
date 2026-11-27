/**
 * Production wiring for interrupted-move-resume (2026-11-14, topic 142440): the drain
 * runner's forced-close hook asks the target to resume instead of only posting a notice,
 * the notice is a conversation notice (not the quiet default), the verb has a real
 * handler that restarts the topic through the same spawn the forwarded-message path uses,
 * and the mesh admits the verb.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkCommandRBAC } from '../../src/core/MeshRpc.js';

const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');

describe('interrupted-move-resume is alive in server boot', () => {
  it('the drain runner hook hands the cut-off step to the target over the mesh', () => {
    const at = server.indexOf('notifyInterrupted: (topic, target, handoff) =>');
    expect(at).toBeGreaterThan(0);
    const block = server.slice(at, at + 4000);
    expect(block).toContain('void handOffInterruptedMove({');
    expect(block).toContain("type: 'interrupted-move-resume', sessionKey: topic, claimEpoch: handoff.claimEpoch");
    expect(block).toContain('INTERRUPTED_MOVE_RESUME_TIMEOUT_MS');
    // The old quiet-default stamp on this notice is gone.
    expect(block).not.toMatch(/withNotificationEnvelope\(stampNotification\(\), async \(\) => \(telegram\)!\s*\.sendToTopic\(topicNum, movedMachinesMidStepNotice/);
    expect(block).toContain('interruptedMoveNoticeEnvelope(inboundMessageId)');
  });

  it('the notice envelope is a conversation category anchored to the person\'s message', () => {
    const at = server.indexOf('function interruptedMoveNoticeEnvelope(');
    expect(at).toBeGreaterThan(0);
    expect(server.slice(at, at + 500)).toContain("category: 'message-loss-notice', sourceContext: 'interrupted-move', inboundMessageId");
  });

  it('the verb has a real handler: own ownership record, same spawn as a forwarded message, one notice', () => {
    const at = server.indexOf("'interrupted-move-resume': async (cmd) =>");
    expect(at).toBeGreaterThan(0);
    const block = server.slice(at, at + 5200);
    expect(block).toContain('new InterruptedMoveResumeReceiver({');
    expect(block).toContain('readOwnership: (key) => ownReg.read(key)');
    expect(block).toContain('sessionManager.injectTelegramMessage(existing, topicId, note');
    expect(block).toContain('spawnSessionForTopic(sessionManager, tg, spawnName, topicId, note, undefined, undefined, movedContext)');
    expect(block).toContain('tg.registerTopicSession(topicId, name, spawnName)');
    // The start holds the topic's start-in-progress token until bound (no second session).
    expect(block).toContain('const startTok = startReg ? startReg.add(topicId) : null;');
    expect(block).toContain('if (startReg && startTok) startReg.clear(topicId, startTok);');
    expect(block).toContain('movedMachinesResumingNotice(targetName)');
    expect(block).toContain('return _interruptedMoveResumeReceiver.receive(req);');
  });

  it('the forwarded-message spawn and the resume share one history pull', () => {
    expect(server).toContain('const pullMovedTopicContext = async (tg: TelegramAdapter, topicId: number)');
    expect(server).toContain('const movedContext = await pullMovedTopicContext(tg, topicId);');
  });

  it('the mesh admits the verb from a registered peer', () => {
    const deps = { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null };
    expect(checkCommandRBAC({ type: 'interrupted-move-resume', sessionKey: '1', claimEpoch: 2 }, 'PEER', deps).ok).toBe(true);
  });
});
