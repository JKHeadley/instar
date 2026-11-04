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

  it('the CLI writes a piped key, refuses a wrong shape, and prints neither', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-key-cli-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, '.instar', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ projectName: 't', port: 4999 }));
    const cli = path.join(ROOT, 'dist/cli.js');
    const out = execFileSync('node', [cli, 'set-claude-key', '--dir', dir], { input: `${KEY}\n`, encoding: 'utf-8' });
    expect(out).not.toContain(KEY);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions.credentials.anthropic.value).toBe(KEY);
    expect(() => execFileSync('node', [cli, 'set-claude-key', '--dir', dir], { input: 'nonsense\n', encoding: 'utf-8', stdio: 'pipe' })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).sessions.credentials.anthropic.value).toBe(KEY);
  });
});
