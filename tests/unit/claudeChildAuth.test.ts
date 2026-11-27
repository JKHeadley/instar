import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyClaudeChildAuth,
  configureClaudeChildAuth,
  configuredClaudeOauthKey,
  writeClaudeAuthEnvFile,
} from '../../src/core/claudeChildAuth.js';

const KEY = `sk-ant-oat01-${'a'.repeat(40)}`;

afterEach(() => configureClaudeChildAuth(null));

describe('applyClaudeChildAuth', () => {
  it('sets the token and clears an API key, the pairing sessions use', () => {
    configureClaudeChildAuth(() => KEY);
    const env = applyClaudeChildAuth({ PATH: '/bin', ANTHROPIC_API_KEY: 'ambient' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(KEY);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('leaves the env alone with no key, so a stored-login agent is unchanged', () => {
    configureClaudeChildAuth(() => undefined);
    expect(applyClaudeChildAuth({ ANTHROPIC_API_KEY: 'ambient' })).toEqual({ ANTHROPIC_API_KEY: 'ambient' });
  });

  it('leaves the env alone before any source is configured', () => {
    expect(applyClaudeChildAuth({ A: '1' })).toEqual({ A: '1' });
  });

  it('never passes a pay-per-call API key to internal calls', () => {
    configureClaudeChildAuth(() => 'sk-ant-api03-paid');
    const env = applyClaudeChildAuth({} as NodeJS.ProcessEnv);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(configuredClaudeOauthKey()).toBeUndefined();
  });

  it('reads the source on every call, so a restored key applies without a restart', () => {
    let current = KEY;
    configureClaudeChildAuth(() => current);
    expect(applyClaudeChildAuth({} as NodeJS.ProcessEnv).CLAUDE_CODE_OAUTH_TOKEN).toBe(KEY);
    current = `${KEY}b`;
    expect(applyClaudeChildAuth({} as NodeJS.ProcessEnv).CLAUDE_CODE_OAUTH_TOKEN).toBe(`${KEY}b`);
  });
});

describe('writeClaudeAuthEnvFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-child-auth-'));

  it('returns null with no oauth key and writes nothing', () => {
    configureClaudeChildAuth(() => 'sk-ant-api03-paid');
    expect(writeClaudeAuthEnvFile(dir)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes a private file a shell can source and delete, keeping the key out of argv', () => {
    configureClaudeChildAuth(() => KEY);
    const file = writeClaudeAuthEnvFile(dir)!;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const script = `. "$1"; rm -f "$1"; printf '%s|%s' "$CLAUDE_CODE_OAUTH_TOKEN" "\${ANTHROPIC_API_KEY-unset}"`;
    const out = execFileSync('/bin/sh', ['-c', script, 'sh', file], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'ambient' },
    });
    expect(out).toBe(`${KEY}|unset`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('quotes a key holding shell syntax so sourcing cannot run it', () => {
    const hostile = `sk-ant-oat01-'; touch ${dir}/pwned; '`;
    configureClaudeChildAuth(() => hostile);
    const file = writeClaudeAuthEnvFile(dir)!;
    const out = execFileSync('/bin/sh', ['-c', `. "$1"; rm -f "$1"; printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"`, 'sh', file], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH },
    });
    expect(out).toBe(hostile);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });
});
