/** fb-03ec0234-b5b: internal model calls must carry the configured key, on both provider paths. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliIntelligenceProvider } from '../../src/core/ClaudeCliIntelligenceProvider.js';
import { configureClaudeChildAuth, setClaudeCallOutcomeListener, writeClaudeKeyToConfig } from '../../src/core/claudeChildAuth.js';

const KEY = `sk-ant-oat01-${'k'.repeat(40)}`;

/** A stand-in `claude` that behaves like the real one: fails "Not logged in" unless the key arrived. */
function fakeClaude(): { bin: string; seen: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const seen = path.join(dir, 'seen');
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s|%s' "\${CLAUDE_CODE_OAUTH_TOKEN:-none}" "$*" > "${seen}"
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  echo '{"is_error":true,"api_error_status":null,"result":"Not logged in · Please run /login"}'; exit 1
fi
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "dead" ]; then :; fi
echo '{"is_error":false,"result":"yes"}'
`, { mode: 0o755 });
  return { bin, seen };
}

afterEach(() => { configureClaudeChildAuth(null); setClaudeCallOutcomeListener(null); });

describe('ClaudeCliIntelligenceProvider on a key-only agent', () => {
  it('fails as before with no key, and names the cause as a category', async () => {
    const { bin } = fakeClaude();
    const outcomes: string[] = [];
    setClaudeCallOutcomeListener((o) => outcomes.push(o));
    await expect(new ClaudeCliIntelligenceProvider(bin).evaluate('hi')).rejects.toThrow(/auth: no-auth/);
    expect(outcomes).toEqual(['no-auth']);
  });

  it('succeeds with the key set, and the key is not in argv', async () => {
    const { bin, seen } = fakeClaude();
    configureClaudeChildAuth(() => KEY);
    const outcomes: string[] = [];
    setClaudeCallOutcomeListener((o) => outcomes.push(o));
    await expect(new ClaudeCliIntelligenceProvider(bin).evaluate('hi')).resolves.toBe('yes');
    const [token, argv] = fs.readFileSync(seen, 'utf-8').split('|');
    expect(token).toBe(KEY);
    expect(argv).not.toContain(KEY);
    expect(outcomes).toEqual(['ok']);
  });

  it('never logs CLI text: an error carrying the key does not reach the message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\necho '{"is_error":true,"api_error_status":401,"result":"bad key ${KEY}"}'; exit 1\n`, { mode: 0o755 });
    configureClaudeChildAuth(() => KEY);
    const err = await new ClaudeCliIntelligenceProvider(bin).evaluate('hi').catch((e: Error) => e);
    expect(String((err as Error).message)).toContain('auth: rejected');
    expect(String((err as Error).message)).not.toContain(KEY);
  });
});

describe('writeClaudeKeyToConfig', () => {
  it('writes the documented field, keeps a base URL, and leaves the rest alone', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
    fs.writeFileSync(file, JSON.stringify({ port: 1, sessions: { maxSessions: 2, credentials: { anthropic: { kind: 'oauth-token', value: 'old', baseUrl: 'http://proxy' } } } }));
    writeClaudeKeyToConfig(file, ` ${KEY}\n`);
    const out = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(out.sessions.credentials.anthropic).toEqual({ kind: 'oauth-token', value: KEY, baseUrl: 'http://proxy' });
    expect(out.port).toBe(1);
    expect(out.sessions.maxSessions).toBe(2);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
