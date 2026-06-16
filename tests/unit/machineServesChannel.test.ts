import { describe, it, expect } from 'vitest';
import { machineServesChannel, type ServesChannels } from '../../src/core/machineServesChannel.js';

const serves = (s: ServesChannels) => s;

describe('machineServesChannel (three-valued, fail-open)', () => {
  it('absent servesChannels (old heartbeat) → unknown (fail-open) for any channel', () => {
    expect(machineServesChannel(undefined, { platform: 'slack', workspaceId: 'W1' })).toBe('unknown');
    expect(machineServesChannel(undefined, { platform: 'telegram', chatId: '-100' })).toBe('unknown');
  });

  it('legacy request (no channel scope) → unknown (fail-open)', () => {
    expect(machineServesChannel(serves({ slack: { workspaceIds: ['W1'] } }), undefined)).toBe('unknown');
  });

  it('telegram: chatId in the set → yes; not in set → no', () => {
    const s = serves({ telegram: { chatIds: ['-100A', '-100B'] } });
    expect(machineServesChannel(s, { platform: 'telegram', chatId: '-100A' })).toBe('yes');
    expect(machineServesChannel(s, { platform: 'telegram', chatId: '-100Z' })).toBe('no');
  });

  it('telegram shared chat → multiple machines both yes (no exclusivity)', () => {
    const a = serves({ telegram: { chatIds: ['-100SHARED'] } });
    const b = serves({ telegram: { chatIds: ['-100SHARED'] } });
    expect(machineServesChannel(a, { platform: 'telegram', chatId: '-100SHARED' })).toBe('yes');
    expect(machineServesChannel(b, { platform: 'telegram', chatId: '-100SHARED' })).toBe('yes');
  });

  it('slack: workspace in the set → yes; different workspace → no (the live-test bug case)', () => {
    const mini = serves({ slack: { workspaceIds: ['T-ECHO-AGENT'] } }); // Mini connected to a DIFFERENT workspace
    expect(machineServesChannel(mini, { platform: 'slack', workspaceId: 'T-LIVE-TEST' })).toBe('no');
    expect(machineServesChannel(mini, { platform: 'slack', workspaceId: 'T-ECHO-AGENT' })).toBe('yes');
  });

  it('present servesChannels with NO block for the platform → no (explicit "not connected"), not unknown', () => {
    // a machine that reports telegram but not slack → slack is an explicit `no`
    const tgOnly = serves({ telegram: { chatIds: ['-100'] } });
    expect(machineServesChannel(tgOnly, { platform: 'slack', workspaceId: 'W1' })).toBe('no');
    const slackOnly = serves({ slack: { workspaceIds: ['W1'] } });
    expect(machineServesChannel(slackOnly, { platform: 'telegram', chatId: '-100' })).toBe('no');
  });

  it('present block but request lacks the scope value → unknown (cannot evaluate, fail-open)', () => {
    const s = serves({ slack: { workspaceIds: ['W1'] } });
    expect(machineServesChannel(s, { platform: 'slack' })).toBe('unknown'); // no workspaceId in the request
    const t = serves({ telegram: { chatIds: ['-100'] } });
    expect(machineServesChannel(t, { platform: 'telegram' })).toBe('unknown'); // no chatId
  });

  it('empty set → no (a present-but-empty list means "connected to nothing")', () => {
    expect(machineServesChannel(serves({ slack: { workspaceIds: [] } }), { platform: 'slack', workspaceId: 'W1' })).toBe('no');
  });
});
