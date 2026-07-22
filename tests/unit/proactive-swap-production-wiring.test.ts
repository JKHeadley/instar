import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const server = fs.readFileSync('src/commands/server.ts', 'utf8');

describe('proactive swap production transport wiring', () => {
  it('constructs the scheduler/monitor when either Telegram or Slack is present', () => {
    expect(server).toContain('if (telegram || _slackAdapter)');
  });

  it('enumeration delegates binding admission to the existing refresh authority', () => {
    expect(server).toContain('refreshable: _sessionRefresh?.canRefreshSession(s.tmuxSession) ?? false');
  });

  it('execute-time effective-source revalidation uses the existing default resolver', () => {
    expect(server).toContain('resolveEffectiveAccountId: async (sessionName, sourceWasUntagged)');
    expect(server).toContain('inUseAccountResolver.resolve(subscriptionPool.list())');
  });
});
