/** A server whose logins all live in the pool must still be able to run the Claude reviewer. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCliIntelligenceProvider } from '../../src/core/ClaudeCliIntelligenceProvider.js';
import { applyClaudeReviewerLogin, configureClaudeChildAuth, configureClaudeReviewerLogin } from '../../src/core/claudeChildAuth.js';
import { toReviewerOutcome, reviewFindingsText } from '../../src/feedback-factory/execute/independentReview.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const KEY = `sk-ant-oat01-${'k'.repeat(40)}`;
const HOME = '/pool/account-a';
const dirs: string[] = [];

/** Behaves like the real CLI on a signed-out default login: fails unless a login home arrived. */
function fakeClaude(): { bin: string; seen: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-login-'));
  dirs.push(dir);
  const bin = path.join(dir, 'claude');
  const seen = path.join(dir, 'seen');
  fs.writeFileSync(bin, `#!/bin/sh
cat > /dev/null
printf '%s' "\${CLAUDE_CONFIG_DIR:-none}" > "${seen}"
if [ -z "$CLAUDE_CONFIG_DIR" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  echo '{"is_error":true,"api_error_status":null,"result":"Not logged in · Please run /login"}'; exit 1
fi
echo '{"is_error":false,"result":"Verdict: CLEAN"}'
`, { mode: 0o755 });
  return { bin, seen };
}

const reviewerCall = (bin: string) => new ClaudeCliIntelligenceProvider(bin).evaluate('hi', { reviewerHardening: { model: 'claude-opus-5-5' } });

let inherited: string | undefined;
beforeEach(() => { inherited = process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_CONFIG_DIR; });
afterEach(() => {
  if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = inherited;
  configureClaudeChildAuth(null);
  configureClaudeReviewerLogin(null);
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/claudeReviewerLogin.test.ts:cleanup' });
});

describe('Claude reviewer login on a machine with a signed-out default login', () => {
  it('fails "Not logged in" with no pool source, which is what every feedback review hit', async () => {
    await expect(reviewerCall(fakeClaude().bin)).rejects.toThrow(/auth: no-auth/);
  });

  it('runs under the pool account the source picks', async () => {
    const { bin, seen } = fakeClaude();
    configureClaudeReviewerLogin(() => HOME);
    await expect(reviewerCall(bin)).resolves.toBe('Verdict: CLEAN');
    expect(fs.readFileSync(seen, 'utf-8')).toBe(HOME);
  });

  it('reads the source on each call, so a change of account applies at once', async () => {
    const { bin, seen } = fakeClaude();
    let home = HOME;
    configureClaudeReviewerLogin(() => home);
    await reviewerCall(bin);
    home = '/pool/account-b';
    await reviewerCall(bin);
    expect(fs.readFileSync(seen, 'utf-8')).toBe('/pool/account-b');
  });

  it('stays refused when no account has room: no silent success', async () => {
    configureClaudeReviewerLogin(() => null);
    await expect(reviewerCall(fakeClaude().bin)).rejects.toThrow(/auth: no-auth/);
  });

  it('a throwing source leaves the env alone rather than breaking the call path', () => {
    configureClaudeReviewerLogin(() => { throw new Error('pool read failed'); });
    expect(applyClaudeReviewerLogin({}).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('a configured key wins over the pool', () => {
    configureClaudeChildAuth(() => KEY);
    configureClaudeReviewerLogin(() => HOME);
    expect(applyClaudeReviewerLogin({}).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('a login the caller already chose wins over the pool', () => {
    configureClaudeReviewerLogin(() => HOME);
    expect(applyClaudeReviewerLogin({ CLAUDE_CONFIG_DIR: '/mine' }).CLAUDE_CONFIG_DIR).toBe('/mine');
  });

  it('only reviewer calls take the pool login: an ordinary internal call is unchanged', async () => {
    const { bin, seen } = fakeClaude();
    configureClaudeReviewerLogin(() => HOME);
    await expect(new ClaudeCliIntelligenceProvider(bin).evaluate('hi')).rejects.toThrow(/auth: no-auth/);
    expect(fs.readFileSync(seen, 'utf-8')).toBe('none');
  });

  it('the server gives the reviewer the same account a new session gets, on both pinning paths', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    expect(server).toContain('sessionManager.setSpawnAccountResolver(pinnedAccount);');
    expect(server).toContain('configureClaudeReviewerLogin(() => pinnedAccount()?.configHome ?? null);');
    expect(server).toContain('configureClaudeReviewerLogin(() => wallRescue.spawnAccount()?.configHome ?? null);');
  });
});

describe('a degraded reviewer says why', () => {
  it('keeps the reason in the text a rework attempt reads', () => {
    const outcome = toReviewerOutcome('claude-code', { status: 'degraded', reason: 'error', model: 'claude-opus-5-5', crossFamily: false, flag: '' } as never);
    expect(reviewFindingsText({ pass: false, reason: 'claude-reviewer-degraded', reviewers: [outcome] })).toContain('degraded (error)');
  });
});
