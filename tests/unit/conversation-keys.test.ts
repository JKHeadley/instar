/**
 * One reference for every conversation (docs/specs/session-swap-any-conversation.md §2, §3.4).
 */
import { describe, it, expect } from 'vitest';
import { conversationKeys, profileKeyKind, appKeyOf, slackRoutingKeyOf, tokenMayWriteConversation, type ConversationWriteFacts } from '../../src/core/conversationKeys.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';

const APP = '0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

describe('conversationKeys', () => {
  it('maps each kind to its profile key, and a bare number to Telegram', () => {
    expect(conversationKeys('telegram:134088')).toEqual({ kind: 'telegram', ref: 'telegram:134088', profileKey: '134088', id: '134088' });
    expect(conversationKeys('134088')).toEqual({ kind: 'telegram', ref: 'telegram:134088', profileKey: '134088', id: '134088' });
    expect(conversationKeys(`app:${APP}`)).toEqual({ kind: 'app', ref: `app:${APP}`, profileKey: `app:${APP}`, id: APP });
    expect(conversationKeys('slack:T0XYZ:C0ABC')).toEqual({ kind: 'slack', ref: 'slack:T0XYZ:C0ABC', profileKey: 'slack:C0ABC', id: 'C0ABC' });
    expect(conversationKeys('slack:_:D0ABC:1730000000.000100')).toMatchObject({ kind: 'slack', profileKey: 'slack:D0ABC:1730000000.000100', id: 'D0ABC:1730000000.000100' });
  });
  it('refuses anything else', () => {
    for (const bad of ['', '0', '-3', 'telegram:abc', 'app:not-a-uuid', `app:${APP.toUpperCase()}`, 'slack:t0xyz:c0abc', 'slack:C0ABC', 'whatsapp:1', 'a'.repeat(201), 7, null]) {
      expect(conversationKeys(bad as unknown), String(bad)).toBeNull();
    }
  });
  it('reads a profile key back to its kind', () => {
    expect(profileKeyKind('134088')).toBe('telegram');
    expect(profileKeyKind(`app:${APP}`)).toBe('app');
    expect(profileKeyKind('slack:C0ABC:1730000000.000100')).toBe('slack');
    expect(profileKeyKind('app:x')).toBeNull();
    expect(appKeyOf(`app:${APP}`)).toBe(APP);
    expect(appKeyOf('134088')).toBeNull();
    expect(slackRoutingKeyOf('slack:C0ABC:1730000000.000100')).toBe('C0ABC:1730000000.000100');
    expect(slackRoutingKeyOf(`app:${APP}`)).toBeNull();
  });
});

describe('who may switch an app or Slack conversation from the dashboard or the phone (§3.4)', () => {
  const facts = (app: Partial<ReturnType<ConversationWriteFacts['app']>> = {}, slack: Partial<ReturnType<ConversationWriteFacts['slack']>> = {}): ConversationWriteFacts => ({
    app: () => ({ known: true, servedHere: true, ownersOwn: true, ...app }),
    slack: () => ({ connected: true, known: true, ...slack }),
  });
  it('the owner\'s own app conversation, served here: yes', () => {
    expect(tokenMayWriteConversation(`app:${APP}`, facts())).toEqual({ ok: true });
  });
  it('a support person\'s conversation, a standby, or a gone one: no, with words saying what to do', () => {
    const r1 = tokenMayWriteConversation(`app:${APP}`, facts({ ownersOwn: false }));
    expect(r1).toMatchObject({ ok: false });
    expect((r1 as { reply: string }).reply).toContain('from their side');
    expect((tokenMayWriteConversation(`app:${APP}`, facts({ servedHere: false })) as { reply: string }).reply).toContain('Another of your machines runs this conversation');
    expect((tokenMayWriteConversation(`app:${APP}`, facts({ known: false })) as { reply: string }).reply).toContain('isn\'t on this agent');
  });
  it('Slack: needs this machine\'s Slack connection and the conversation known here', () => {
    expect(tokenMayWriteConversation('slack:C0ABC', facts())).toEqual({ ok: true });
    expect((tokenMayWriteConversation('slack:C0ABC', facts({}, { connected: false })) as { reply: string }).reply).toContain('isn\'t connected to Slack');
    expect((tokenMayWriteConversation('slack:C0ABC', facts({}, { known: false })) as { reply: string }).reply).toContain('Send it a message first');
  });
  it('no message names Telegram for an app or Slack conversation', () => {
    for (const r of [tokenMayWriteConversation(`app:${APP}`, facts({ known: false })), tokenMayWriteConversation('slack:C0ABC', facts({}, { known: false }))]) {
      expect((r as { reply: string }).reply).not.toMatch(/topic|Telegram/i);
    }
  });
});

describe('the phone\'s door takes any conversation (§3.5)', () => {
  it('signs the reference exactly as sent; a bare topic id still works', () => {
    const line = (target: string) => { const b = buildAction('session-door', target, { framework: 'codex' }); if (!b.ok) throw new Error(b.error); return actionLine(b.action); };
    expect(line(`app:${APP}`)).toBe(`session-door app:${APP} here codex none`);
    expect(line('slack:T0XYZ:C0ABC')).toBe('session-door slack:T0XYZ:C0ABC here codex none');
    expect(line('134088')).toBe('session-door 134088 here codex none');
    expect(buildAction('session-door', 'app:nope', { framework: 'codex' })).toMatchObject({ ok: false, error: 'bad-target' });
    expect(buildAction('session-door', 'slack:t0xyz:c0abc', { framework: 'codex' })).toMatchObject({ ok: false, error: 'bad-target' });
  });
  it('the allowlist admits each kind (on the lower-cased path) and nothing with %', () => {
    const admits = (p: string) => DEVICE_ALLOWLIST.some((r) => r.method === 'POST' && r.re.test(p.toLowerCase()));
    expect(admits(`/mobile/sessions/door/app:${APP}`)).toBe(true);
    expect(admits('/mobile/sessions/door/slack:T0XYZ:C0ABC:1730000000.000100')).toBe(true);
    expect(admits('/mobile/sessions/door/telegram:7')).toBe(true);
    expect(admits('/mobile/sessions/door/7')).toBe(true);
    expect(admits('/mobile/sessions/door/app%3A1')).toBe(false);
    expect(admits('/mobile/sessions/door/whatsapp:1')).toBe(false);
    // Moving is still Telegram only in this part.
    expect(admits(`/mobile/sessions/move/app:${APP}`)).toBe(false);
  });
});
