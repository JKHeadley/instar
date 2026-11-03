/**
 * Door "signed in" verdicts (spec install-experience section 5): one live call, both sides of the
 * boundary, and `unknown` whenever the answer can't be measured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetFrameworkBinaryCache } from '../../src/core/Config.js';
import {
  detectDoorPath,
  redetectDoorPath,
  detectRunningDoor,
  doorSignInArgs,
  hasBrowser,
  proveClaudeSignedIn,
  proveCodexSignedIn,
} from '../../src/commands/install/doors.js';

const token = { ok: true as const, oauth: { accessToken: 'sk-ant-oat-test' } };
const respond = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
const noRefresh = async () => ({ ok: false as const, reason: 'no-refresh-token' as const });

describe('Claude signed-in proof', () => {
  const base = { configHome: '/x', platform: 'linux' as const, accountEmail: () => null, refresh: noRefresh, env: {}, fileExists: () => false };

  it('is signed in only on a live 200', async () => {
    expect(await proveClaudeSignedIn({ ...base, readOauth: async () => token as never, fetchImpl: respond(200) })).toBe('signed-in');
  });

  it('is signed out when the token is refused and refresh fails', async () => {
    expect(await proveClaudeSignedIn({ ...base, readOauth: async () => token as never, fetchImpl: respond(401) })).toBe('signed-out');
  });

  it('recovers an expired token through refresh rather than a new sign-in', async () => {
    let calls = 0;
    const fetchImpl = (async () => new Response('{}', { status: ++calls === 1 ? 401 : 200 })) as unknown as typeof fetch;
    expect(await proveClaudeSignedIn({ ...base, readOauth: async () => token as never, fetchImpl, refresh: async () => ({ ok: true as const, accessToken: 't', expiresAt: 0, rotated: false }) })).toBe('signed-in');
  });

  it('stays unknown when a refresh failure says nothing about the login', async () => {
    const refused = { ...base, readOauth: async () => token as never, fetchImpl: respond(401) };
    for (const failure of [
      { reason: 'exchange-failed', status: 503 },
      { reason: 'exchange-failed', status: 429 },
      { reason: 'exchange-failed' },
      { reason: 'write-skipped' },
      { reason: 'write-failed' },
      { reason: 'malformed-response' },
    ]) {
      expect(await proveClaudeSignedIn({ ...refused, refresh: (async () => ({ ok: false, ...failure })) as never })).toBe('unknown');
    }
    expect(await proveClaudeSignedIn({ ...refused, refresh: (async () => ({ ok: false, reason: 'exchange-failed', status: 400 })) as never })).toBe('signed-out');
  });

  it('never calls someone on an API key or Bedrock signed out', async () => {
    const missing = async () => ({ ok: false as const, reason: 'missing-or-unreadable' as const });
    for (const env of [{ ANTHROPIC_API_KEY: 'k' }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: '1' }]) {
      expect(await proveClaudeSignedIn({ ...base, env, readOauth: missing as never })).toBe('unknown');
    }
  });

  it('reads a credentials file that exists but did not read as unknown', async () => {
    const missing = async () => ({ ok: false as const, reason: 'missing-or-unreadable' as const });
    expect(await proveClaudeSignedIn({ ...base, readOauth: missing as never, fileExists: () => true })).toBe('unknown');
  });

  it('is unknown on a rate limit or a network failure, never signed out', async () => {
    expect(await proveClaudeSignedIn({ ...base, readOauth: async () => token as never, fetchImpl: respond(429) })).toBe('unknown');
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await proveClaudeSignedIn({ ...base, readOauth: async () => token as never, fetchImpl: down })).toBe('unknown');
  });

  it('treats no credential as signed out, except a Mac with a recorded account, which may be a locked keychain', async () => {
    const missing = async () => ({ ok: false as const, reason: 'missing-or-unreadable' as const });
    expect(await proveClaudeSignedIn({ ...base, readOauth: missing as never })).toBe('signed-out');
    expect(await proveClaudeSignedIn({ ...base, readOauth: missing as never, platform: 'darwin' })).toBe('signed-out');
    expect(await proveClaudeSignedIn({ ...base, readOauth: missing as never, platform: 'darwin', accountEmail: () => 'a@b.c' })).toBe('unknown');
  });

  it('reads an unparseable store as unknown so a possibly working login is never overwritten', async () => {
    expect(await proveClaudeSignedIn({ ...base, readOauth: (async () => ({ ok: false, reason: 'unparseable' })) as never })).toBe('unknown');
  });
});

describe('finding a door right after installing it', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-detect-')); });
  afterEach(() => {
    _resetFrameworkBinaryCache();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/install cleanup' });
  });

  it('sees a binary that appeared after the first look', () => {
    const savedHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      _resetFrameworkBinaryCache();
      const first = detectDoorPath('codex-cli');
      const bin = path.join(dir, '.codex', 'bin', 'codex');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(detectDoorPath('codex-cli')).toBe(first);
      expect(redetectDoorPath('codex-cli')).toBe(bin);
    } finally {
      process.env.HOME = savedHome;
    }
  });
});

describe('Codex signed-in proof', () => {
  const statusOf = (stdout: string, code: number) => async () => ({ code, stdout, stderr: '' });

  it('follows the live read when it answers', async () => {
    expect(await proveCodexSignedIn({ liveRead: async () => ({ kind: 'ok', snapshot: {} as never }) })).toBe('signed-in');
    expect(await proveCodexSignedIn({ liveRead: async () => ({ kind: 'auth-failed' }) })).toBe('signed-out');
  });

  it('uses login status only to prove there is nothing to overwrite', async () => {
    const liveRead = async () => ({ kind: 'unavailable' as const });
    expect(await proveCodexSignedIn({ liveRead, loginStatus: statusOf('Not logged in', 1) })).toBe('signed-out');
    expect(await proveCodexSignedIn({ liveRead, loginStatus: statusOf('Logged in using ChatGPT', 0) })).toBe('unknown');
    expect(await proveCodexSignedIn({ liveRead, loginStatus: statusOf('', 127) })).toBe('unknown');
  });
});

describe('sign-in routing', () => {
  it('uses a device code for Codex with no browser', () => {
    expect(doorSignInArgs('codex-cli', true)).toEqual(['login']);
    expect(doorSignInArgs('codex-cli', false)).toEqual(['login', '--device-auth']);
    expect(doorSignInArgs('claude-code', true)).toEqual(['auth', 'login']);
  });

  it('sees a browser on a desktop, not on a bare server', () => {
    expect(hasBrowser({}, 'darwin')).toBe(true);
    expect(hasBrowser({ DISPLAY: ':0' }, 'linux')).toBe(true);
    expect(hasBrowser({ SSH_CONNECTION: '1 2 3 4' }, 'darwin')).toBe(false);
    expect(hasBrowser({ SSH_TTY: '/dev/pts/1', DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(hasBrowser({}, 'linux')).toBe(process.platform === 'linux' && /microsoft/i.test(os.release()));
  });

  it('recognizes the harness running the installer', () => {
    expect(detectRunningDoor({ CLAUDECODE: '1' })).toBe('claude-code');
    expect(detectRunningDoor({ CODEX_THREAD_ID: 'x' })).toBe('codex-cli');
    expect(detectRunningDoor({})).toBeUndefined();
  });
});
