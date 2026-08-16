/**
 * Unit test — WS5.2 §5.3/S7 resolveFollowMeEnrollTarget: the operator-approved enrollment target
 * is resolved AUTHORITATIVELY from real pool state (local pool first, then peer views), and FAILS
 * CLOSED when no holder reports a usable email. The email must NEVER come from a request body.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveFollowMeEnrollTarget,
  followMeConfigHomePrefix,
} from '../../src/core/resolveFollowMeEnrollTarget.js';
import type { MachinePoolView } from '../../src/core/accountFollowMeDepth.js';

describe('resolveFollowMeEnrollTarget', () => {
  it('resolves from the LOCAL pool (most authoritative), carrying provider/framework/label', () => {
    const r = resolveFollowMeEnrollTarget({
      accountId: 'a1',
      localAccounts: [{ id: 'a1', email: 'approved@x.com', nickname: 'main', provider: 'anthropic', framework: 'claude-code' }],
      peerViews: [],
    });
    expect(r).toEqual({ resolved: true, expectedEmail: 'approved@x.com', provider: 'anthropic', framework: 'claude-code', label: 'main' });
  });

  it('resolves from a PEER view when the account is not held locally (replicated meta projection)', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'approved@x.com', status: 'active', locallyHeld: false }] },
    ];
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [], peerViews });
    expect(r).toMatchObject({ resolved: true, expectedEmail: 'approved@x.com', provider: 'anthropic', framework: 'claude-code', label: 'a1' });
  });

  it('fails closed when local and peer holder identity conflicts', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'peer@x.com', status: 'active', locallyHeld: false }] },
    ];
    const r = resolveFollowMeEnrollTarget({
      accountId: 'a1',
      localAccounts: [{ id: 'a1', email: 'local@x.com', nickname: 'main', provider: 'anthropic', framework: 'claude-code' }],
      peerViews,
    });
    expect(r).toMatchObject({ resolved: false, code: 'account-record-email-conflict' });
  });

  it('FAILS CLOSED when no holder reports an email', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', status: 'active', locallyHeld: false }] },
    ];
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [{ id: 'a1' }], peerViews });
    expect(r).toEqual({
      resolved: false,
      code: 'account-record-missing-email',
      reason: 'This subscription account record is missing its email. Repair or re-enroll the account, then try again.',
    });
  });

  it('FAILS CLOSED for an unknown account', () => {
    const r = resolveFollowMeEnrollTarget({
      accountId: 'nope',
      localAccounts: [{ id: 'a1', email: 'approved@x.com' }],
      peerViews: [{ machineId: 'mini', nickname: 'm', accounts: [{ accountId: 'a1', email: 'approved@x.com', status: 'active', locallyHeld: false }] }],
    });
    expect(r.resolved).toBe(false);
  });

  it('treats a blank/whitespace email as unresolvable (fail-closed)', () => {
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [{ id: 'a1', email: '   ' }], peerViews: [] });
    expect(r.resolved).toBe(false);
  });

  // The bug this guards: a peer-only Codex account resolved to anthropic/claude-code, so the
  // target machine ran the Claude sign-in flow for an OpenAI account. It could never complete, and
  // the consumer retried forever. The account's kind must come from the holder that actually has
  // it, never from a default.
  it('carries the HOLDER provider/framework for a peer-only account instead of defaulting to Claude', () => {
    const peerViews: MachinePoolView[] = [
      {
        machineId: 'mini',
        nickname: 'the Mini',
        accounts: [{
          accountId: 'codex-sagemindai',
          email: 'justin@sagemindai.io',
          status: 'active',
          locallyHeld: true,
          provider: 'openai',
          framework: 'codex-cli',
        }],
      },
    ];
    const r = resolveFollowMeEnrollTarget({ accountId: 'codex-sagemindai', localAccounts: [], peerViews });
    expect(r).toMatchObject({
      resolved: true,
      expectedEmail: 'justin@sagemindai.io',
      provider: 'openai',
      framework: 'codex-cli',
    });
  });

  it('prefers the LOCAL kind when this machine already holds the account', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'approved@x.com', status: 'active', locallyHeld: true, provider: 'anthropic', framework: 'claude-code' }] },
    ];
    const r = resolveFollowMeEnrollTarget({
      accountId: 'a1',
      localAccounts: [{ id: 'a1', email: 'approved@x.com', nickname: 'main', provider: 'anthropic', framework: 'claude-code' }],
      peerViews,
    });
    expect(r).toMatchObject({ resolved: true, provider: 'anthropic', framework: 'claude-code' });
  });

  it('FAILS CLOSED when holders disagree about the kind of account', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'same@x.com', status: 'active', locallyHeld: true, provider: 'openai', framework: 'codex-cli' }] },
    ];
    const r = resolveFollowMeEnrollTarget({
      accountId: 'a1',
      localAccounts: [{ id: 'a1', email: 'same@x.com', provider: 'anthropic', framework: 'claude-code' }],
      peerViews,
    });
    expect(r).toMatchObject({ resolved: false, code: 'account-record-kind-conflict' });
  });

  it('a holder that omits the kind abstains rather than voting for the default', () => {
    const peerViews: MachinePoolView[] = [
      // An older peer build that does not send provider/framework at all.
      { machineId: 'old', nickname: 'old', accounts: [{ accountId: 'a1', email: 'same@x.com', status: 'active', locallyHeld: true }] },
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'same@x.com', status: 'active', locallyHeld: true, provider: 'openai', framework: 'codex-cli' }] },
    ];
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [], peerViews });
    expect(r).toMatchObject({ resolved: true, provider: 'openai', framework: 'codex-cli' });
  });
});

describe('followMeConfigHomePrefix', () => {
  // Each CLI reads its own home, so a codex credential under a .claude-followme-* path is
  // invisible to `codex` — the enrollment writes a file nothing will ever read.
  it('gives each framework its own home prefix', () => {
    expect(followMeConfigHomePrefix('codex-cli')).toBe('.codex-followme-');
    expect(followMeConfigHomePrefix('gemini-cli')).toBe('.gemini-followme-');
    expect(followMeConfigHomePrefix('pi-cli')).toBe('.pi-followme-');
  });

  it('keeps the existing claude-code path for claude-code and for an unknown framework', () => {
    expect(followMeConfigHomePrefix('claude-code')).toBe('.claude-followme-');
    expect(followMeConfigHomePrefix(undefined)).toBe('.claude-followme-');
    expect(followMeConfigHomePrefix('something-new')).toBe('.claude-followme-');
  });
});
