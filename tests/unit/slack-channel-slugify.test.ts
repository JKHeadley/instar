import { describe, it, expect } from 'vitest';
import { slugifyChannelName, validateChannelName } from '../../src/messaging/slack/sanitize.js';

/**
 * Regression coverage for the Slack system-channel name bug:
 * `ensureSlackUpdatesChannel` / `ensureSlackAttentionChannel` in
 * src/commands/server.ts built `${agentName}-sys-updates` from an
 * un-slugified workspaceName, so a name like "SageMind Live Test"
 * produced "SageMind Live Test-sys-updates" which `validateChannelName`
 * (and therefore `ChannelManager.createChannel`) rejected with
 * "Invalid channel name". The fix slugifies the segment first.
 */
describe('slugifyChannelName', () => {
  it('slugifies a workspace name with spaces and uppercase (the bug case)', () => {
    expect(slugifyChannelName('SageMind Live Test')).toBe('sagemind-live-test');
  });

  it('produces a name that passes validateChannelName when suffixed (the actual failure path)', () => {
    const seg = slugifyChannelName('SageMind Live Test');
    // The exact call shape the server makes for the two system channels.
    expect(validateChannelName(`${seg}-sys-updates`)).toBe(true);
    expect(validateChannelName(`${seg}-sys-attention`)).toBe(true);
  });

  it('demonstrates the un-slugified name would have FAILED validation (proves the bug was real)', () => {
    expect(validateChannelName('SageMind Live Test-sys-updates')).toBe(false);
  });

  it('leaves an already-valid lowercase-hyphenated name unchanged', () => {
    expect(slugifyChannelName('echo')).toBe('echo');
    expect(slugifyChannelName('ai-guy')).toBe('ai-guy');
  });

  it('collapses runs of separators and trims leading/trailing hyphens', () => {
    expect(slugifyChannelName('  Dawn   //  Portal!! ')).toBe('dawn-portal');
    expect(slugifyChannelName('---Hello---')).toBe('hello');
  });

  it('strips symbols, underscores-from-non-alnum, and unicode to hyphens', () => {
    expect(slugifyChannelName('Acme™ Corp (Prod)')).toBe('acme-corp-prod');
  });

  it('falls back to "agent" when the input slugs away to empty', () => {
    expect(slugifyChannelName('!!!')).toBe('agent');
    expect(slugifyChannelName('   ')).toBe('agent');
    expect(slugifyChannelName('')).toBe('agent');
  });

  it('preserves digits', () => {
    expect(slugifyChannelName('Team 42 Alpha')).toBe('team-42-alpha');
  });
});
