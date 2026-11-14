/**
 * native-conversation-base §3a — agent awareness, migration parity and the server
 * wiring that makes the held-reply changes live (wiring integrity: not null, not a no-op).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginHeldLateAwareness, HELD_REPLY_LATE_AWARENESS_MARKER } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('held-reply late-delivery awareness installation parity', () => {
  it('new agents learn the late line, the session lines, the three causes, the reasons and the feedback tag', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(telegramOriginHeldLateAwareness());
    for (const phrase of ['a later message never ends it', 'Telegram refused it', 'it could not be sent before its attempts ran out', 'it passed its delivery deadline',
      '/telegram/origins/operations/ID/text', 'duplicate-content', 'suppressed-at-holder', 'late-reply-stale', 'do not send it again unless the user says it is missing']) {
      expect(md).toContain(phrase);
    }
  });
  it('existing agents receive it once, in CLAUDE.md and the framework shadow', () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'held-late-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1741' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split(HELD_REPLY_LATE_AWARENESS_MARKER)).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split(HELD_REPLY_LATE_AWARENESS_MARKER)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:held-late-migration:cleanup' });
    }
  });
});

describe('server wiring (the held-reply changes are live, not no-ops)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
  it('the timestamp review is gone from the server and the boot', () => {
    expect(source).not.toContain('reviewQueuedReply');
    expect(source).not.toContain('QueuedReplySupersession');
    expect(fs.readFileSync(path.join(process.cwd(), 'src/messaging/telegram-origin/TelegramOriginBoot.ts'), 'utf8')).not.toContain('reviewQueuedReply');
    expect(fs.existsSync(path.join(process.cwd(), 'src/messaging/telegram-origin/QueuedReplySupersession.ts'))).toBe(false);
  });
  it('the session-line injector types into the bound running session through the session manager', () => {
    const block = source.slice(source.indexOf('telegramOriginBoot.runtime.options.injectSessionLine = '), source.indexOf('telegramOriginBoot.runtime.options.injectSessionLine = ') + 500);
    expect(block).toContain('state.getSession(binding.sessionId)');
    expect(block).toContain("session.status !== 'running'");
    expect(block).toContain('sessionManager.sendInput(session.tmuxSession, text)');
    expect(source).toContain('telegramOriginBoot.runtime.options.syncUnresolvedTopics = ');
    expect(source).toContain('`telegram-origin-unresolved:${topicId}`');
  });
  it('the forward ladder reads the holder receipt raw and hands verdicts to the runtime', () => {
    const block = source.slice(source.indexOf('runtime.options.forwardRecovery = async (operation, row) => {'), source.indexOf('runtime.options.onLeaseHoldObserved = async row => {'));
    expect(block).toContain('originForwardMod.classifyHolderReceipt(reply, operationId, machineId)');
    expect(block).not.toContain("'suppressed', 'superseded'].includes(state)) return { state: 'not-accepted' }");
    for (const wire of ['endAtHolder:', "holdReason: 'suppressed-at-holder'", 'mergeDetail:', 'runtime.store.mergeHoldDetail', 'onOwnerVerdict:', 'runtime.handOwnerVerdict',
      'onOwnerUnstatedSettled:', 'runtime.handOwnerUnstated', 'onLateUnmarked:', 'runtime.countLateUnmarked', 'firstPreparedAt: carrier.firstPreparedAt']) {
      expect(block).toContain(wire);
    }
  });
  it('a replacement is prepared under the original producer record with its sealed policy input', () => {
    expect(source).toContain('service.runAsRecordedProducer(replacement.record, prepare)');
    expect(source).toContain('policyInput: replacement?.policyInput ?? service.currentSendPolicyInput(input.text, input.kindMetadata)');
    expect(source).toContain("'replacement-part-limit'");
  });
});
