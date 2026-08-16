/**
 * Tier-1 tests for the §5.1 per-account serveability derivation (spec:
 * cross-machine-account-quota-sharing.md §5.1/§5.2). Both sides of every boundary:
 * serveable vs walled vs channel-unreachable, and the no-summary safe direction.
 */
import { describe, it, expect } from 'vitest';
import {
  hasNonWalledAccount,
  buildServeCapabilitySummary,
  resolveCanServe,
} from '../../src/core/serveCapability.js';

describe('hasNonWalledAccount', () => {
  it('blocked:true ⇒ walled', () => {
    expect(hasNonWalledAccount({ blocked: true })).toBe(false);
  });
  it('blocked:false ⇒ non-walled', () => {
    expect(hasNonWalledAccount({ blocked: false })).toBe(true);
  });
  it('absent quotaState (older heartbeat) ⇒ non-walled (fail-open)', () => {
    expect(hasNonWalledAccount(undefined)).toBe(true);
  });
});

describe('buildServeCapabilitySummary', () => {
  it('serveable: not-walled + telegram channel', () => {
    const s = buildServeCapabilitySummary({ blocked: false }, { telegram: { chatIds: ['100'] } });
    expect(s).toEqual({ hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['100'] } } });
  });
  it('walled: blocked account, no servesChannels block omitted', () => {
    const s = buildServeCapabilitySummary({ blocked: true }, undefined);
    expect(s).toEqual({ hasNonWalledAccount: false });
  });
});

describe('resolveCanServe', () => {
  const reqTg = { platform: 'telegram' as const, chatId: '100' };

  it('serveable: non-walled + channel reachable (yes)', () => {
    const summary = { hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['100'] } } };
    expect(resolveCanServe(summary, reqTg)).toEqual({ canServe: true, reason: 'serveable' });
  });

  it('walled: hasNonWalledAccount false ⇒ canServe:false (walled), regardless of channel', () => {
    const summary = { hasNonWalledAccount: false, servesChannels: { telegram: { chatIds: ['100'] } } };
    expect(resolveCanServe(summary, reqTg)).toEqual({ canServe: false, reason: 'walled' });
  });

  it('channel-unreachable: non-walled but adapter NOT on this chat ⇒ canServe:false', () => {
    const summary = { hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['999'] } } };
    expect(resolveCanServe(summary, reqTg)).toEqual({ canServe: false, reason: 'channel-unreachable' });
  });

  it('fail-open: non-walled + unknown channel signal (no servesChannels) ⇒ serveable', () => {
    const summary = { hasNonWalledAccount: true };
    // machineServesChannel returns 'unknown' (no serves block) → fail-open → serveable.
    expect(resolveCanServe(summary, reqTg)).toEqual({ canServe: true, reason: 'serveable' });
  });

  it('fail-open: non-walled + no requirement (legacy/no scope) ⇒ serveable', () => {
    const summary = { hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['100'] } } };
    expect(resolveCanServe(summary, undefined)).toEqual({ canServe: true, reason: 'serveable' });
  });

  it('no-summary: an unadvertised peer is NOT a candidate (safe direction)', () => {
    expect(resolveCanServe(undefined, reqTg)).toEqual({ canServe: false, reason: 'no-summary' });
  });

  it('slack workspace mismatch ⇒ channel-unreachable', () => {
    const summary = { hasNonWalledAccount: true, servesChannels: { slack: { workspaceIds: ['T1'] } } };
    expect(resolveCanServe(summary, { platform: 'slack', workspaceId: 'T2' })).toEqual({ canServe: false, reason: 'channel-unreachable' });
  });
});
