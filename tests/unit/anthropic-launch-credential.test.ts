/**
 * fb-7cb86d4b-1fd — session launch must honor `sessions.credentials.anthropic`.
 *
 * Every claude-code spawn path builds CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from
 * SessionManagerConfig.anthropicApiKey. Before this fix that field was read ONLY from the legacy
 * `sessions.anthropicApiKey`, so an install configured the documented way (credentials map) launched
 * every session with an empty token and Claude Code answered "Not logged in" (found 2026-11-02 on a
 * fresh Linux cloud agent). These tests cover both sides of the precedence decision and the
 * non-string edge, through the real loadConfig() path as well as the helper.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAnthropicLaunchFields, loadConfig } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OAT = 'sk-ant-oat01-' + 'x'.repeat(40);
const LEGACY = 'sk-ant-api03-' + 'y'.repeat(40);

describe('resolveAnthropicLaunchFields', () => {
  it('uses credentials.anthropic when only the credentials map is set (the bug)', () => {
    const r = resolveAnthropicLaunchFields({ credentials: { anthropic: { kind: 'oauth-token', value: OAT } } });
    expect(r.anthropicApiKey).toBe(OAT);
    expect(r.anthropicBaseUrl).toBeUndefined();
  });

  it('keeps the legacy field working when no credentials map exists', () => {
    const r = resolveAnthropicLaunchFields({ anthropicApiKey: LEGACY, anthropicBaseUrl: 'http://127.0.0.1:9000' });
    expect(r.anthropicApiKey).toBe(LEGACY);
    expect(r.anthropicBaseUrl).toBe('http://127.0.0.1:9000');
  });

  it('prefers the explicit credentials entry over the legacy field (same precedence as buildCredentialsMap)', () => {
    const r = resolveAnthropicLaunchFields({
      anthropicApiKey: LEGACY,
      anthropicBaseUrl: 'http://legacy',
      credentials: { anthropic: { kind: 'oauth-token', value: OAT, baseUrl: 'http://explicit' } },
    });
    expect(r.anthropicApiKey).toBe(OAT);
    expect(r.anthropicBaseUrl).toBe('http://explicit');
  });

  it('falls back field-by-field: explicit key without baseUrl keeps the legacy baseUrl', () => {
    const r = resolveAnthropicLaunchFields({
      anthropicBaseUrl: 'http://legacy',
      credentials: { anthropic: { kind: 'oauth-token', value: OAT } },
    });
    expect(r.anthropicApiKey).toBe(OAT);
    expect(r.anthropicBaseUrl).toBe('http://legacy');
  });

  it('ignores a non-string or empty credential value instead of stringifying it', () => {
    expect(resolveAnthropicLaunchFields({ credentials: { anthropic: { kind: 'oauth-token', value: { secret: true } } } }).anthropicApiKey).toBeUndefined();
    expect(resolveAnthropicLaunchFields({ credentials: { anthropic: { kind: 'oauth-token', value: '' } }, anthropicApiKey: LEGACY }).anthropicApiKey).toBe(LEGACY);
  });

  it('returns nothing for an install with no Anthropic credential at all', () => {
    expect(resolveAnthropicLaunchFields(undefined)).toEqual({ anthropicApiKey: undefined, anthropicBaseUrl: undefined });
    expect(resolveAnthropicLaunchFields({ credentials: { openai: { kind: 'api-key', value: 'sk-x' } } })).toEqual({ anthropicApiKey: undefined, anthropicBaseUrl: undefined });
  });
});

describe('loadConfig wiring (the production path every spawn reads)', () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/anthropic-launch-credential.test.ts' });
  });

  function write(sessions: Record<string, unknown>): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-anthropic-cred-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Test');
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), JSON.stringify({
      sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', ...sessions },
    }));
    return tmpDir;
  }

  it('a credentials-map-only install reaches sessions.anthropicApiKey (no more "Not logged in")', () => {
    const cfg = loadConfig(write({ credentials: { anthropic: { kind: 'oauth-token', value: OAT } } }));
    expect(cfg.sessions.anthropicApiKey).toBe(OAT);
    expect(cfg.sessions.credentials?.anthropic?.value).toBe(OAT);
  });

  it('a legacy-only install is unchanged', () => {
    const cfg = loadConfig(write({ anthropicApiKey: LEGACY }));
    expect(cfg.sessions.anthropicApiKey).toBe(LEGACY);
  });
});
