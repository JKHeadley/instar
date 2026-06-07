/**
 * Unit tests for FrameworkLoginDriver (P2.1). The scrape logic is pure and
 * tested against realistic captured-output fixtures for both flows (Codex
 * device-code; Claude URL+code-paste). The drive() loop is tested with injected
 * fakes (no tmux, no spawning, no network, no real waiting).
 */

import { describe, it, expect } from 'vitest';
import { FrameworkLoginDriver } from '../../src/core/FrameworkLoginDriver.js';

// Realistic Codex device-code login output.
const CODEX_PANE = `
  Sign in to OpenAI to continue.

  To authenticate, visit: https://auth.openai.com/codex/device
  and enter code: 7DAU-W4XJA

  This code expires in 15 minutes.
  Waiting for authorization...
`;

// Realistic Claude Code URL+paste-back login output.
const CLAUDE_PANE = `
  Visit the following URL to authorize Claude Code:

  https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=user

  Paste the code you receive back here:
`;

describe('FrameworkLoginDriver.parseArtifact', () => {
  it('scrapes a Codex device-code artifact (url + code + ttl)', () => {
    const a = FrameworkLoginDriver.parseArtifact(CODEX_PANE, 'device-code');
    expect(a).not.toBeNull();
    expect(a!.verificationUrl).toBe('https://auth.openai.com/codex/device');
    expect(a!.userCode).toBe('7DAU-W4XJA');
    expect(a!.ttlMs).toBe(15 * 60_000);
  });

  it('scrapes a Claude url-code-paste artifact (url only, no device code needed)', () => {
    const a = FrameworkLoginDriver.parseArtifact(CLAUDE_PANE, 'url-code-paste');
    expect(a).not.toBeNull();
    expect(a!.verificationUrl).toBe(
      'https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=user',
    );
    expect(a!.userCode).toBeUndefined(); // paste-back code flows user→CLI, not scraped
  });

  it('returns null for a device-code flow until the code has printed', () => {
    const partial = 'To authenticate, visit: https://auth.openai.com/codex/device\nWaiting...';
    expect(FrameworkLoginDriver.parseArtifact(partial, 'device-code')).toBeNull();
  });

  it('returns null when no URL has appeared yet', () => {
    expect(FrameworkLoginDriver.parseArtifact('Starting login...', 'url-code-paste')).toBeNull();
    expect(FrameworkLoginDriver.parseArtifact('', 'device-code')).toBeNull();
  });

  it('strips trailing punctuation off a captured URL', () => {
    const a = FrameworkLoginDriver.parseArtifact('Go to https://claude.ai/oauth/x.', 'url-code-paste');
    expect(a!.verificationUrl).toBe('https://claude.ai/oauth/x');
  });

  it('parses a seconds-based TTL', () => {
    const a = FrameworkLoginDriver.parseArtifact(
      'visit https://x/device code ABCD-1234 — expires in 900 seconds',
      'device-code',
    );
    expect(a!.ttlMs).toBe(900_000);
  });
});

describe('FrameworkLoginDriver.drive', () => {
  function fakeDeps(captures: string[]) {
    let clock = 0;
    let i = 0;
    return {
      clock: () => clock,
      deps: {
        spawn: async () => ({ session: 'login-pane-1' }),
        capture: async () => captures[Math.min(i++, captures.length - 1)],
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
        pollIntervalMs: 1_000,
        scrapeTimeoutMs: 60_000,
      },
    };
  }

  it('polls until the artifact appears, then returns it', async () => {
    const { deps } = fakeDeps(['booting...', 'still booting...', CODEX_PANE]);
    const driver = new FrameworkLoginDriver(deps);
    const a = await driver.drive({ provider: 'openai', framework: 'codex-cli', kind: 'device-code' });
    expect(a.userCode).toBe('7DAU-W4XJA');
  });

  it('throws on timeout when the artifact never appears', async () => {
    const { deps } = fakeDeps(['booting...']); // never yields a URL
    const driver = new FrameworkLoginDriver(deps);
    await expect(
      driver.drive({ provider: 'openai', framework: 'codex-cli', kind: 'device-code' }),
    ).rejects.toThrow(/not found/);
  });

  it('asLoginDriver() adapts to the EnrollmentWizard signature', async () => {
    const { deps } = fakeDeps([CLAUDE_PANE]);
    const driver = new FrameworkLoginDriver(deps);
    const fn = driver.asLoginDriver();
    const a = await fn({ provider: 'anthropic', framework: 'claude-code', kind: 'url-code-paste' });
    expect(a.verificationUrl).toContain('claude.ai/oauth');
  });
});
