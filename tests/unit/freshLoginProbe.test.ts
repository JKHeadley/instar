// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * freshLoginProbe (spec docs/specs/stale-process-login-expired.md, D1): the verdict is read from the
 * CLI's REAL structured output (fixtures captured from Claude Code 2.1.329 on 2026-11-20), the probe
 * can use nothing but the stored login, and it never runs tools, MCP servers, hooks or settings.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyFreshProbe, freshProbeArgs, freshProbeEnv, runFreshLoginProbe } from '../../src/core/freshLoginProbe.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/fresh-login-probe/${name}`, import.meta.url), 'utf8');
const OK = fixture('ok.stream.jsonl');
const NOT_LOGGED_IN = fixture('not-logged-in.stream.jsonl');

/** Rewrite the result line of a real stream (keeps every other real byte). */
function withResult(stream: string, patch: Record<string, unknown>): string {
  return stream.split('\n').map((l) => {
    if (!l.trim().startsWith('{')) return l;
    const o = JSON.parse(l);
    return o.type === 'result' ? JSON.stringify({ ...o, ...patch }) : l;
  }).join('\n');
}
function withInit(stream: string, patch: Record<string, unknown>): string {
  return stream.split('\n').map((l) => {
    if (!l.trim().startsWith('{')) return l;
    const o = JSON.parse(l);
    return o.type === 'system' && o.subtype === 'init' ? JSON.stringify({ ...o, ...patch }) : l;
  }).join('\n');
}

describe('classifyFreshProbe on real CLI output', () => {
  it('a real successful stored-login call is ok, with usage for the metrics row', () => {
    const r = classifyFreshProbe({ exitCode: 0, timedOut: false, stdout: OK });
    expect(r.verdict).toBe('ok');
    expect(r.usage?.model).toBeTruthy();
    expect(r.usage?.tokensOut).toBeGreaterThan(0);
  });
  it('a real not-logged-in run (subtype success, is_error true) is refused, never ok', () => {
    const r = classifyFreshProbe({ exitCode: 1, timedOut: false, stdout: NOT_LOGGED_IN });
    expect(r).toMatchObject({ verdict: 'refused', reason: 'not-logged-in' });
  });
  it('the reply wording does not matter: "Okay" from a clean call is ok', () => {
    expect(classifyFreshProbe({ exitCode: 0, timedOut: false, stdout: withResult(OK, { result: 'Okay' }) }).verdict).toBe('ok');
  });
  it('an error whose text contains OK is not ok', () => {
    const r = classifyFreshProbe({ exitCode: 1, timedOut: false, stdout: withResult(OK, { is_error: true, result: 'API Error: OK not allowed' }) });
    expect(r.verdict).not.toBe('ok');
  });
  it("Anthropic's 401 is refused", () => {
    const r = classifyFreshProbe({ exitCode: 1, timedOut: false, stdout: withResult(OK, { is_error: true, api_error_status: 401, result: 'Invalid authentication credentials' }) });
    expect(r).toMatchObject({ verdict: 'refused', reason: 'auth-rejected' });
  });
  it('a usage-limit answer is not-run (not evidence about the login)', () => {
    const r = classifyFreshProbe({ exitCode: 1, timedOut: false, stdout: withResult(OK, { is_error: true, result: "You've hit your weekly limit" }) });
    expect(r).toMatchObject({ verdict: 'not-run', reason: 'usage-limit' });
  });
  it('a call authenticated by an API key, or not served by Anthropic, is unavailable', () => {
    expect(classifyFreshProbe({ exitCode: 0, timedOut: false, stdout: withInit(OK, { apiKeySource: 'ANTHROPIC_API_KEY' }) })).toMatchObject({ verdict: 'unavailable', reason: 'non-login-auth' });
    expect(classifyFreshProbe({ exitCode: 0, timedOut: false, stdout: withInit(OK, { served_by_anthropic: false }) })).toMatchObject({ verdict: 'unavailable', reason: 'non-login-auth' });
  });
  it('timeout, no result line, or no output tokens is unavailable', () => {
    expect(classifyFreshProbe({ exitCode: null, timedOut: true, stdout: OK }).verdict).toBe('unavailable');
    expect(classifyFreshProbe({ exitCode: 0, timedOut: false, stdout: 'garbage' }).verdict).toBe('unavailable');
    expect(classifyFreshProbe({ exitCode: 0, timedOut: false, stdout: withResult(OK, { usage: { output_tokens: 0 } }) }).verdict).toBe('unavailable');
  });
});

describe('probe containment', () => {
  it('runs with no tools, MCP servers, hooks, settings sources or transcript', () => {
    const a = freshProbeArgs();
    const at = (flag: string) => a[a.indexOf(flag) + 1];
    expect(at('--tools')).toBe('');
    expect(at('--setting-sources')).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(at('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(JSON.parse(at('--settings'))).toEqual({ disableAllHooks: true });
    expect(a).toContain('--no-session-persistence');
    expect(at('--max-turns')).toBe('1');
  });
  it('strips every credential and provider switch, and points at the login folder only', () => {
    const env = freshProbeEnv({
      PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://x',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'p', AWS_PROFILE: 'a',
      CLAUDECODE: '1', CLAUDE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: '/other', INSTAR_AUTH_TOKEN: 'secret',
    }, '/logins/acct');
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/logins/acct' });
  });
});

describe('runFreshLoginProbe against a stand-in claude', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'freshLoginProbe test cleanup' }); dir = ''; });
  function standIn(script: string): string {
    dir = mkdtempSync(path.join(tmpdir(), 'flp-'));
    const bin = path.join(dir, 'claude');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }
  it('passes the login folder, keeps a planted key out, and classifies the real bytes', async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'flp-out-')), 'env.txt');
    const okFile = path.join(path.dirname(out), 'ok.jsonl');
    writeFileSync(okFile, OK);
    const bin = standIn(`env > "${out}"\ncat "${okFile}"`);
    const r = await runFreshLoginProbe({ claudePath: () => bin, cwd: dir, env: () => ({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'planted' }) }, '/logins/acct');
    expect(r.verdict).toBe('ok');
    const seen = readFileSync(out, 'utf8');
    expect(seen).toContain('CLAUDE_CONFIG_DIR=/logins/acct');
    expect(seen).not.toContain('planted');
    SafeFsExecutor.safeRmSync(path.dirname(out), { recursive: true, force: true, operation: 'freshLoginProbe test cleanup' });
  });
  it('a hung CLI times out as unavailable', async () => {
    const bin = standIn('sleep 5');
    const r = await runFreshLoginProbe({ claudePath: () => bin, cwd: dir, timeoutMs: 300 }, '/logins/acct');
    expect(r).toMatchObject({ verdict: 'unavailable' });
  });
  it('no claude binary is unavailable, not a throw', async () => {
    expect(await runFreshLoginProbe({ claudePath: () => null, cwd: tmpdir() }, '/x')).toMatchObject({ verdict: 'unavailable', reason: 'no-claude-binary' });
  });
});
