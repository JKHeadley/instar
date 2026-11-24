/**
 * SEC-164 part 1 slice 1b: new incoming messages are masked before anything keeps them, a team member
 * gets the fixed notice with a Secret Drop link once per message, strangers get nothing, and the
 * session is told. Fake keys are built at run time so no key-shaped literal sits in the source.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  maskInbound, isTeamSender, teamMemberNotice, sessionRemovedKeyNote,
} from '../../src/messaging/inboundCredentialMask.js';
import { InboundCredentialNotice } from '../../src/server/inboundCredentialNotice.js';
import { CREDENTIAL_REMOVED_MARKER } from '../../src/messaging/outbound-credential-guard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ghToken = 'ghp_' + 'x'.repeat(36);
const botToken = '123456789:' + 'AA' + 'b'.repeat(16) + 'C' + 'd'.repeat(16);

function notifier(over: Partial<ConstructorParameters<typeof InboundCredentialNotice>[0]> = {}) {
  const sent: Array<{ target: string; channel: string; text: string }> = [];
  const failures: string[] = [];
  const n = new InboundCredentialNotice({
    enabled: () => true,
    mintResendLink: () => 'https://agent.example/secrets/drop/tok',
    sendNotice: (m) => { sent.push(m); },
    reportFailure: (r) => { failures.push(r); },
    ...over,
  });
  return { n, sent, failures };
}

describe('SEC-164 1b: maskInbound', () => {
  it('masks every key to the same marker and keeps the surrounding text', () => {
    const r = maskInbound(`here is ${ghToken} and ${botToken} ok`, { enabled: true });
    expect(r.outcome).toBe('masked');
    expect(r.text).toBe(`here is ${CREDENTIAL_REMOVED_MARKER} and ${CREDENTIAL_REMOVED_MARKER} ok`);
    expect(r.text).not.toContain(ghToken);
    expect(r.kinds.length).toBeGreaterThan(0);
  });

  it('masks a replayed message to identical text (SEC-106 inputSnapshot holds)', () => {
    const a = maskInbound(`k ${ghToken}`, { enabled: true }).text;
    const b = maskInbound(`k ${ghToken}`, { enabled: true }).text;
    expect(a).toBe(b);
  });

  it('leaves text alone when the switch is off or the text is clean', () => {
    expect(maskInbound(`k ${ghToken}`, { enabled: false })).toMatchObject({ outcome: 'off', text: `k ${ghToken}` });
    expect(maskInbound('just words, chat id 123456789', { enabled: true }).outcome).toBe('clean');
  });
});

describe('SEC-164 1b: isTeamSender', () => {
  it('counts the owner and listed members, never a forward, a chat post, a bot, a guest or an unknown id', () => {
    expect(isTeamSender({ channel: 'telegram', senderId: 42, ownerIds: [42] })).toBe(true);
    expect(isTeamSender({ channel: 'telegram', senderId: 7, ownerIds: [42], memberIds: ['7'] })).toBe(true);
    expect(isTeamSender({ channel: 'telegram', senderId: 42, ownerIds: [42], notFromThePerson: true })).toBe(false);
    expect(isTeamSender({ channel: 'slack', senderId: 'U1', memberIds: ['U1'], externalOrGuest: true })).toBe(false);
    expect(isTeamSender({ channel: 'telegram', senderId: 9, ownerIds: [42] })).toBe(false);
    expect(isTeamSender({ channel: 'telegram', senderId: null, ownerIds: [42] })).toBe(false);
  });
});

describe('SEC-164 1b: InboundCredentialNotice', () => {
  it('a team member gets the fixed notice with a Secret Drop link, and the session sees the note', async () => {
    const { n, sent } = notifier();
    const r = n.mask(`use ${ghToken}`, { channel: 'telegram', senderId: null });
    expect(r.removed).toBe(true);
    r.team = true;
    expect(await n.notify({ target: '55', messageKey: '1', channel: 'telegram', result: r })).toBe('sent');
    expect(sent).toEqual([{ target: '55', channel: 'telegram', text: teamMemberNotice('https://agent.example/secrets/drop/tok') }]);
    expect(sent[0]!.text).not.toContain(ghToken);
    expect(n.sessionText(r.text, r)).toBe(`use ${CREDENTIAL_REMOVED_MARKER}\n\n${sessionRemovedKeyNote(true)}`);
  });

  it('a stranger is masked and gets no notice', async () => {
    const { n, sent } = notifier();
    const r = n.mask(`use ${ghToken}`, { channel: 'telegram', senderId: 9, ownerIds: [42] });
    expect(r.removed).toBe(true);
    expect(r.team).toBe(false);
    expect(r.text).not.toContain(ghToken);
    expect(await n.notify({ target: '55', messageKey: '1', channel: 'telegram', result: r })).toBe('skipped');
    expect(sent).toEqual([]);
    expect(n.sessionText(r.text, r)).toContain(sessionRemovedKeyNote(false));
  });

  it('a re-forwarded message never sends a second notice', async () => {
    const { n, sent } = notifier();
    const r = { ...n.mask(`use ${ghToken}`, { channel: 'telegram', senderId: null }), team: true };
    await n.notify({ target: '55', messageKey: '1', channel: 'telegram', result: r });
    expect(await n.notify({ target: '55', messageKey: '1', channel: 'telegram', result: r })).toBe('skipped');
    expect(sent).toHaveLength(1);
  });

  it('a message with no id is never deduped, so it cannot silence later notices', async () => {
    const { n, sent } = notifier();
    const r = { ...n.mask(`use ${ghToken}`, { channel: 'telegram', senderId: null }), team: true };
    await n.notify({ target: '55', messageKey: '', channel: 'telegram', result: r });
    await n.notify({ target: '55', messageKey: '', channel: 'telegram', result: r });
    expect(sent).toHaveLength(2);
  });

  it('when the link cannot be made, the notice says so and the failure is reported', async () => {
    const { n, sent, failures } = notifier({ mintResendLink: () => { throw new Error('cap'); } });
    const r = { ...n.mask(`use ${ghToken}`, { channel: 'telegram', senderId: null }), team: true };
    expect(await n.notify({ target: '55', messageKey: '2', channel: 'telegram', result: r })).toBe('sent');
    expect(sent[0]!.text).toBe(teamMemberNotice(null));
    expect(failures).toEqual(['resend link could not be made']);
  });

  it('a clean message is unchanged and nothing is sent', async () => {
    const { n, sent } = notifier();
    const r = n.mask('hello there', { channel: 'telegram', senderId: 42, ownerIds: [42] });
    expect(r.removed).toBe(false);
    expect(n.sessionText('hello there', r)).toBe('hello there');
    expect(await n.notify({ target: '55', messageKey: '3', channel: 'telegram', result: r })).toBe('skipped');
    expect(sent).toEqual([]);
  });

  it('an unreadable switch is off: the message is delivered unchanged', () => {
    const { n } = notifier({ enabled: () => { throw new Error('bad config'); } });
    expect(n.mask(`use ${ghToken}`, { channel: 'telegram', senderId: null }).text).toBe(`use ${ghToken}`);
  });

  it('a failing send is reported and never throws', async () => {
    const { n, failures } = notifier({ sendNotice: () => { throw new Error('down'); } });
    const r = { ...n.mask(`use ${ghToken}`, { channel: 'slack', senderId: null }), team: true };
    expect(await n.notify({ target: 'C1', messageKey: '9', channel: 'slack', result: r })).toBe('failed');
    expect(failures).toEqual(['team notice could not be sent']);
  });
});

describe('SEC-164 1b: wiring (source order)', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf-8');

  it('the Telegram forward handler masks before normalizing, the trust-account ingest and the inbound log', () => {
    const src = read('src/server/routes.ts');
    const start = src.indexOf('const telegramForwardHandler = async');
    const body = src.slice(start, src.indexOf('\n  };\n', start));
    const mask = body.indexOf('inboundCredentialNotice.mask(text');
    expect(mask).toBeGreaterThan(0);
    for (const sink of ['normalizeForwardedInbound(', 'ctx.trustAccountPath.ingest(', 'logInboundMessage(', 'onTopicMessage(message)']) {
      expect(body.indexOf(sink), sink).toBeGreaterThan(mask);
    }
  });

  it('the Telegram polling path masks before the trust-account receipt and the unknown-user path', () => {
    const src = read('src/messaging/TelegramAdapter.ts');
    const start = src.indexOf('private async processUpdateDelivered(');
    const body = src.slice(start, start + 20000);
    const mask = body.indexOf('this.inboundCredentialMasker({');
    expect(mask).toBeGreaterThan(0);
    expect(body.indexOf('this.onTrustAccountPathReceipt({')).toBeGreaterThan(mask);
    expect(body.indexOf('this.handleUnknownUser(')).toBeGreaterThan(mask);
  });

  it('Slack masks before the trust-account receipt, the ring buffer and the auth gate', () => {
    const src = read('src/messaging/slack/SlackAdapter.ts');
    const start = src.indexOf('private async _handleMessage(');
    const body = src.slice(start, start + 8000);
    const mask = body.indexOf('this.inboundCredentialMasker({');
    expect(mask).toBeGreaterThan(0);
    expect(body.indexOf('this.onTrustAccountPathReceipt({')).toBeGreaterThan(mask);
    expect(body.indexOf('buffer.push(')).toBeGreaterThan(mask);
  });

  it('the routes attach both adapter maskers to the same notifier', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain('ctx.telegram.inboundCredentialMasker = ');
    expect(src).toContain('ctx.slack.inboundCredentialMasker = ');
  });
});

describe('SEC-164 1b: a key never reaches the notice sender', () => {
  it('the notice text is fixed wording with no part of the message', async () => {
    const send = vi.fn();
    const { n } = notifier({ sendNotice: send });
    const r = { ...n.mask(`secret ${botToken} please`, { channel: 'telegram', senderId: null }), team: true };
    await n.notify({ target: '1', messageKey: 'x', channel: 'telegram', result: r });
    const text = (send.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toContain('please');
    expect(text).not.toContain(botToken);
  });
});

describe('SEC-164 1b: the lifeline queue never holds a key', () => {
  it('a queued message is written masked, with its kinds and never the value', async () => {
    const os = await import('node:os');
    const { MessageQueue } = await import('../../src/lifeline/MessageQueue.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-q-'));
    try {
      const q = new MessageQueue(dir, { credentialScrubEnabled: () => true });
      expect(q.enqueue({ id: 'tg-1', topicId: 5, text: `take ${ghToken}`, fromUserId: 42, fromFirstName: 'A', timestamp: new Date().toISOString() })).toBe(true);
      const onDisk = fs.readFileSync(path.join(dir, 'lifeline-queue.json'), 'utf-8');
      expect(onDisk).not.toContain(ghToken);
      expect(onDisk).toContain(CREDENTIAL_REMOVED_MARKER);
      const [entry] = q.peek();
      expect(entry!.text).toBe(`take ${CREDENTIAL_REMOVED_MARKER}`);
      expect(entry!.credentialRemovedKinds!.length).toBeGreaterThan(0);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec164-inbound-mask.test.ts' }); }
  });

  it('with the switch off the queue is unchanged, and a clean message carries no flag', async () => {
    const os = await import('node:os');
    const { MessageQueue } = await import('../../src/lifeline/MessageQueue.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-q-'));
    try {
      const off = new MessageQueue(dir, { credentialScrubEnabled: () => false });
      off.enqueue({ id: 'tg-2', topicId: 5, text: `take ${ghToken}`, fromUserId: 42, fromFirstName: 'A', timestamp: new Date().toISOString() });
      expect(off.peek()[0]!.text).toBe(`take ${ghToken}`);
      const on = new MessageQueue(dir, { credentialScrubEnabled: () => true });
      on.enqueue({ id: 'tg-3', topicId: 5, text: 'hello', fromUserId: 42, fromFirstName: 'A', timestamp: new Date().toISOString() });
      expect(on.peek().find((m) => m.id === 'tg-3')!.credentialRemovedKinds).toBeUndefined();
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec164-inbound-mask.test.ts' }); }
  });

  it('the replay forwards the removed-key kinds, and the server accepts them only from a proven lifeline', () => {
    const lifeline = read('src/lifeline/TelegramLifeline.ts');
    expect(lifeline).toContain('}, replayAck, undefined, msg.credentialRemovedKinds);');
    expect(lifeline).toContain('{ credentialRemovedKinds }');
    const routes = read('src/server/routes.ts');
    expect(routes).toMatch(/!credMask\.removed && \(trust \? true : ingressDecision\.verified === true\) && Array\.isArray\(queuedKinds\)/);
  });

  it('the dropped-messages record and the Slack lifeline queue mask too, and the session router masks before saving', () => {
    expect(read('src/lifeline/droppedMessages.ts')).toMatch(/maskInbound\(args\.text, \{ enabled \}\)\.text\.slice\(0, TEXT_PREVIEW_MAX\)/);
    expect(read('src/lifeline/SlackLifeline.ts')).toContain('maskInbound(msg.text, { enabled })');
    const router = read('src/messaging/MessageRouter.ts');
    const send = router.slice(router.indexOf('  async send('));
    expect(send.indexOf('maskInbound(body')).toBeGreaterThan(0);
    expect(send.indexOf('maskInbound(body')).toBeLessThan(send.indexOf('this.store'));
    expect(read('src/commands/server.ts')).toContain('credentialScrubEnabled: credentialScrubEnabledReader(config.projectDir),');
  });
});

function read(p: string): string { return fs.readFileSync(path.resolve(p), 'utf-8'); }

describe('SEC-164 1b: WhatsApp and iMessage mask before the log', () => {
  it('WhatsApp masks at the top of handleIncomingMessage, before the group path and the log', () => {
    const src = read('src/messaging/WhatsAppAdapter.ts');
    const body = src.slice(src.indexOf('  async handleIncomingMessage('));
    const mask = body.indexOf('text = this.maskIncomingCredential(text);');
    expect(mask).toBeGreaterThan(0);
    expect(body.indexOf('this.handleGroupMessage(')).toBeGreaterThan(mask);
    expect(body.indexOf('this.logger.append(')).toBeGreaterThan(mask);
  });

  it('iMessage masks after the sender checks and before the trigger check and the log', () => {
    const src = read('src/messaging/imessage/IMessageAdapter.ts');
    const body = src.slice(src.indexOf('  private async _handleIncomingMessage('));
    const mask = body.indexOf('this.maskIncomingCredential(msg.text)');
    expect(mask).toBeGreaterThan(body.indexOf('rowMayActAsContact(msg)'));
    expect(body.indexOf('this._checkTrigger(')).toBeGreaterThan(mask);
    expect(body.indexOf('this._logMessage(')).toBeGreaterThan(mask);
  });

  it('the routes attach the masker to both adapters', () => {
    expect(read('src/server/routes.ts')).toContain('for (const adapter of [ctx.whatsapp, ctx.imessage]) {');
  });
});

describe('SEC-164 1b: app read path, transcripts and file names', () => {
  it('the read path always masks a key, and keeps removing authority tokens', async () => {
    const { transcriptForDelivery } = await import('../../src/core/AppConversationService.js');
    expect(transcriptForDelivery(`said ${ghToken} aloud`)).toBe(`said ${CREDENTIAL_REMOVED_MARKER} aloud`);
  });

  it('removeAuthorityTokensAndKeys masks only when asked, and reports the kinds', async () => {
    const { removeAuthorityTokensAndKeys } = await import('../../src/core/appConversationText.js');
    expect(removeAuthorityTokensAndKeys(`k ${ghToken}`, false).text).toBe(`k ${ghToken}`);
    const on = removeAuthorityTokensAndKeys(`k ${ghToken}`, true);
    expect(on.text).toBe(`k ${CREDENTIAL_REMOVED_MARKER}`);
    expect(on.kinds.length).toBeGreaterThan(0);
  });

  it('a server transcript is masked when the switch is on, and unchanged when off', async () => {
    const { scrubServerTranscript } = await import('../../src/core/AppConversationService.js');
    expect(scrubServerTranscript(`k ${ghToken}`, null, true).text).toBe(`k ${CREDENTIAL_REMOVED_MARKER}`);
    expect(scrubServerTranscript(`k ${ghToken}`, null).text).toBe(`k ${ghToken}`);
  });

  it('every app ingress masks before removing authority tokens and passes the switch to the media preflight', () => {
    for (const f of ['src/server/mobileConversationRoutes.ts', 'src/server/mobileSlackRoutes.ts', 'src/server/mobilePairingRoutes.ts']) {
      const src = read(f);
      const mask = src.indexOf('maskInbound(text, { enabled: appCredentialScrubOn(deps.config) })');
      expect(mask, f).toBeGreaterThan(0);
      expect(src.indexOf('removeAuthorityTokens(credMasked.text)'), f).toBeGreaterThan(mask);
      expect(src, f).toContain('maskCredentials: appCredentialScrubOn(deps.config) })');
    }
  });
});

describe('SEC-164 1b: Telegram voice transcripts', () => {
  it('a transcript is masked before it is logged or handed to the session', () => {
    const src = read('src/messaging/TelegramAdapter.ts');
    const body = src.slice(src.indexOf('private async handleVoiceMessage('));
    const mask = body.indexOf('text: transcript, topicId, messageId: msg.message_id');
    expect(mask).toBeGreaterThan(0);
    expect(body.indexOf('[telegram] Transcribed voice')).toBeGreaterThan(mask);
    expect(body.indexOf('content: `[voice] ${safeTranscript}`')).toBeGreaterThan(mask);
  });
});
