import { describe, expect, it } from 'vitest';
import {
  dashboardRefreshFailure,
  dashboardRefreshGateScript,
  dashboardRefreshScript,
} from '../../src/server/DashboardRefreshDiagnostics.js';
import { getDefaultJobs } from '../../src/commands/init.js';

describe('dashboard refresh diagnostics', () => {
  it('formats actionable failure responses for the dashboard refresh route', () => {
    expect(dashboardRefreshFailure(
      'broadcast',
      'Telegram API rejected editMessageText',
      'Verify the Dashboard forum topic still exists.',
    )).toEqual({
      error: 'Dashboard refresh failed',
      action: 'failed',
      stage: 'broadcast',
      detail: 'Telegram API rejected editMessageText',
      nextStep: 'Verify the Dashboard forum topic still exists.',
    });
  });

  it('uses native fetch in the default job script and prints request diagnostics', () => {
    const script = dashboardRefreshScript(4555);
    const gate = dashboardRefreshGateScript(4555);

    expect(script).toContain("const port = process.env.INSTAR_PORT || '4555'");
    expect(script).toContain('await fetch(url');
    expect(script).toContain('[dashboard-link-refresh] failed: HTTP ');
    expect(script).toContain('Next step:');
    expect(script).not.toContain('curl');
    expect(gate).toContain("const port = process.env.INSTAR_PORT || '4555'");
    expect(gate).toContain('await fetch(url');
    expect(gate).toContain('[dashboard-link-refresh] gate failed:');
    expect(gate).not.toContain('curl');
  });

  it('installs dashboard-link-refresh with the diagnostic script', () => {
    const job = getDefaultJobs(4555).find((candidate) => {
      return (candidate as { slug?: string }).slug === 'dashboard-link-refresh';
    }) as { gate?: string; execute?: { type?: string; value?: string } } | undefined;

    expect(job?.gate).toContain('[dashboard-link-refresh] gate failed:');
    expect(job?.gate).not.toContain('curl');
    expect(job?.execute?.type).toBe('script');
    expect(job?.execute?.value).toContain('[dashboard-link-refresh] failed:');
    expect(job?.execute?.value).toContain('http://localhost:');
    expect(job?.execute?.value).not.toContain('curl');
  });
});
