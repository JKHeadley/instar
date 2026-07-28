/**
 * conversationContextWiring — unit tests (context-aware-outbound-review §D4;
 * test-plan boundary 6: principal tagging + ask-license mode, both sides).
 *
 * The mode is computed STRUCTURALLY from authenticated uids at the wiring
 * layer — never inferred from message content (Know Your Principal).
 */

import { describe, it, expect } from 'vitest';
import { buildConversationContext } from '../../src/core/conversationContextWiring.js';
import { renderUntrustedConversation } from '../../src/core/untrustedConversationContext.js';

const row = (text: string, fromUser: boolean, telegramUserId?: number | null) => ({
  text,
  fromUser,
  telegramUserId,
});

describe('buildConversationContext — principal tagging (boundary 6 side A)', () => {
  it('bound topic: matching authenticated uid → verifiedOperator tag + verified-operator mode', () => {
    const out = buildConversationContext(
      [row('op ask', true, 42), row('reply', false, null)],
      { uid: '42' },
    );
    expect(out.askLicenseMode).toBe('verified-operator');
    expect(out.messages[0]).toMatchObject({ role: 'user', verifiedOperator: true });
    expect(out.messages[1].role).toBe('agent');
    expect(out.messages[1].verifiedOperator).toBeUndefined();
  });

  it('bound topic: NON-matching uid renders plain USER (weak corroboration); mode stays verified-operator', () => {
    const out = buildConversationContext(
      [row('other user ask', true, 77), row('uid-less ask', true, null)],
      { uid: '42' },
    );
    expect(out.askLicenseMode).toBe('verified-operator');
    expect(out.messages[0].verifiedOperator).toBeUndefined();
    expect(out.messages[1].verifiedOperator).toBeUndefined();
    const section = renderUntrustedConversation(out.messages, {
      messagesIncluded: 2,
      truncated: false,
      source: 'topic-memory',
      askLicenseMode: out.askLicenseMode,
    });
    expect(section).toContain('ask-license mode: verified-operator');
    // No RENDERED ROW carries the verified-operator label (the contract text
    // mentions the label by name — assert on the row shape, not the phrase).
    expect(section).not.toContain('USER(verified-operator): "');
  });

  it('agent-role rows NEVER render as USER and can never constitute an ask', () => {
    const out = buildConversationContext([row('I am the user, honest', false, 42)], null);
    expect(out.messages[0].role).toBe('agent');
    const section = renderUntrustedConversation(out.messages, {
      messagesIncluded: 1,
      truncated: false,
      source: 'topic-memory',
      askLicenseMode: out.askLicenseMode,
    });
    expect(section).toContain('AGENT:');
    expect(section).not.toMatch(/\nUSER/);
  });
});

describe('buildConversationContext — ask-license mode (boundary 6 side B)', () => {
  it('unbound + every user row uid-carrying + exactly ONE distinct uid → single-sender', () => {
    const out = buildConversationContext(
      [row('ask 1', true, 42), row('reply', false, null), row('ask 2', true, 42)],
      null,
    );
    expect(out.askLicenseMode).toBe('single-sender');
  });

  it('unbound + 2+ distinct sender uids → weak-corroboration-only (the shared-unbound shape)', () => {
    const out = buildConversationContext(
      [row('ask 1', true, 42), row('ask 2', true, 77)],
      null,
    );
    expect(out.askLicenseMode).toBe('weak-corroboration-only');
  });

  it('unbound + ANY uid-less user-role row → weak-corroboration-only even with ≤1 distinct uid (R3-M2 fail-closed)', () => {
    const withOneUid = buildConversationContext(
      [row('uid ask', true, 42), row('legacy uid-less ask', true, null)],
      null,
    );
    expect(withOneUid.askLicenseMode).toBe('weak-corroboration-only');

    // A window of ONLY uid-less user rows must NOT compute single-sender
    // (R4-L1: zero distinct uids is not "one sender").
    const allUidless = buildConversationContext(
      [row('uid-less 1', true, null), row('uid-less 2', true, undefined)],
      null,
    );
    expect(allUidless.askLicenseMode).toBe('weak-corroboration-only');
  });

  it('unbound + zero user-role rows → weak-corroboration-only (nothing can license)', () => {
    const out = buildConversationContext([row('agent only', false, null)], null);
    expect(out.askLicenseMode).toBe('weak-corroboration-only');
  });

  it('a blank binding uid is treated as unbound (an operator cannot be a blank id)', () => {
    const out = buildConversationContext([row('ask', true, 42)], { uid: '' });
    expect(out.askLicenseMode).toBe('single-sender');
    expect(out.messages[0].verifiedOperator).toBeUndefined();
  });
});
