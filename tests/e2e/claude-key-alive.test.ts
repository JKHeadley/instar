/**
 * Tier 3: the production wiring is alive. Real SessionManager hooks and the real CLI, and the
 * server.ts composition that puts key handling ahead of the pool sink on every agent.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const ROOT = path.resolve(__dirname, '../..');
const KEY = `sk-ant-oat01-${'e'.repeat(40)}`;

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-key-e2e-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  const config = { projectDir: dir, tmuxPath: 'tmux', claudePath: 'claude', protectedSessions: [], completionPatterns: [], maxSessions: 1, anthropicApiKey: 'old' } as unknown as SessionManagerConfig;
  return { sm: new SessionManager(config, new StateManager(path.join(dir, '.instar'))), config };
}

describe('claude key wiring', () => {
  it('server.ts wires it outside the pool block, ahead of the pool sink, with real deps', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const wired = source.indexOf('sessionManager.prependInteractiveLoginExpiredSink(');
    const pool = source.indexOf('sessionManager.setInteractiveLoginExpiredSink(');
    expect(wired).toBeGreaterThan(pool);
    expect(source).toContain('setClaudeCallOutcomeListener((outcome) => claudeKeyHealth.noteCallOutcome(outcome))');
    expect(source).toContain('sessionManager.setAnthropicKey(key)');
    expect(source).toMatch(/configureClaudeChildAuth\(\(\) =>/);
  });

  it('recovery is wired to answer held messages and to reach a person (2026-11-04 drill)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const start = source.indexOf('new ClaudeKeyHealth({');
    const block = source.slice(start, source.indexOf('setActiveClaudeKeyHealth(claudeKeyHealth)', start));
    // Each restarted conversation gets its held messages and reply command, and is checked for a real answer.
    expect(block).toMatch(/recoveryPrompt: async \(sessionName\) => \{[\s\S]*buildKeyRecoveryPrompt\(convo\.channel, heldMessages\(/);
    expect(block).toMatch(/answeredSince: async \(sessionName, sinceMs\) => \{[\s\S]*answeredSince\(convo\.lines, sinceMs/);
    // The operator notice counts only when a person can read it.
    expect(block).toMatch(/notifyOperator: \(text\) => \{[\s\S]*deliverOperatorNotice\(/);
    expect(block).toMatch(/readersOf: async \(channelId\) => \{[\s\S]*slack\.authorizedMembersOf\(channelId\)/);
    expect(block).toContain('people: () => keyOperators(slack)');
    // Server posts (standby notes) are told apart from session replies by the origin ledger.
    expect(source).toContain('isServerPost: (ts) => slack.isServerAutomationPost(channelId, ts)');
    expect(block).toContain('directMessage: async (userId, t) => { await slack.sendDirectMessage(userId, t); }');
  });

  it('the shipped Slack reply script drops a channel id in a bound session', () => {
    const script = fs.readFileSync(path.join(ROOT, 'src/templates/scripts/slack-reply.sh'), 'utf-8');
    expect(script).toContain('slack-reply-feature: session-drops-channel-arg');
  });

  it('a restored key reaches the copy SessionManager launches from', () => {
    const { sm, config } = manager();
    sm.setAnthropicKey(KEY);
    expect(config.anthropicApiKey).toBe(KEY);
  });

  it('the key handler runs first, and a handled signal skips the pool', async () => {
    const { sm } = manager();
    const calls: string[] = [];
    sm.setInteractiveLoginExpiredSink(() => { calls.push('pool'); });
    let handled = true;
    sm.prependInteractiveLoginExpiredSink(async () => { calls.push('key'); return handled; });
    const sink = (sm as unknown as { interactiveLoginExpiredSink: (i: unknown) => Promise<void> }).interactiveLoginExpiredSink;
    await sink({});
    expect(calls).toEqual(['key']);
    handled = false;
    await sink({});
    expect(calls).toEqual(['key', 'key', 'pool']);
  });

  it('works on an agent with no pool sink at all', async () => {
    const { sm } = manager();
    sm.prependInteractiveLoginExpiredSink(async () => false);
    const sink = (sm as unknown as { interactiveLoginExpiredSink: (i: unknown) => Promise<void> }).interactiveLoginExpiredSink;
    await expect(sink({})).resolves.toBeUndefined();
  });

  it('the CLI writes a piped key without Claude installed, refuses a wrong shape, and prints neither', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-key-cli-'));
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-key-no-cli-'));
    const env = { ...process.env, PATH: emptyPath, INSTAR_FRAMEWORK: 'claude-code' };
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, '.instar', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ projectName: 't', port: 4999 }));
    const cli = path.join(ROOT, 'dist/cli.js');
    const out = execFileSync(process.execPath, [cli, 'set-claude-key', '--dir', dir], { input: `${KEY}\n`, encoding: 'utf-8', env });
    expect(out).not.toContain(KEY);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions.credentials.anthropic.value).toBe(KEY);
    expect(() => execFileSync(process.execPath, [cli, 'set-claude-key', '--dir', dir], { input: 'nonsense\n', encoding: 'utf-8', stdio: 'pipe', env })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions.credentials.anthropic.value).toBe(KEY);
  });
});
