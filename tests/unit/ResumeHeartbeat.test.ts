/**
 * The resume heartbeat tick carries each session's FRAMEWORK with its id, and
 * production runs this exact tick (source pins on commands/server.ts). Without
 * the framework the map checked a Claude id in every layout and a stale one
 * walked the Codex archive every minute (2026-10-13 server-loop freeze).
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildResumeHeartbeatInput, runResumeHeartbeatTick, type ResumeHeartbeatDeps } from '../../src/core/ResumeHeartbeat.js';

const ROOT = path.resolve(__dirname, '..', '..');

function deps(overrides: Partial<ResumeHeartbeatDeps> = {}): ResumeHeartbeatDeps & { refresh: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn>; saveSlack: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn();
  const exists = vi.fn((_uuid: string, framework?: string) => framework === 'claude-code');
  const saveSlack = vi.fn();
  return {
    refresh, exists, saveSlack,
    topicResumeMap: { refreshResumeMappings: refresh, jsonlExistsPublic: exists } as never,
    listRunningSessions: () => [
      { tmuxSession: 'echo-claude', claudeSessionId: 'ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4', framework: 'claude-code' },
      { tmuxSession: 'echo-codex', claudeSessionId: '01a0de4a-bc5e-7761-a89d-e44faaeadb00', framework: 'codex-cli' },
      { tmuxSession: 'echo-legacy', claudeSessionId: 'legacy-id' },
      { tmuxSession: 'echo-noid', framework: 'claude-code' },
    ],
    telegramTopicSessions: () => [[61449, 'echo-claude'], [9210, 'echo-codex'], [1, 'echo-legacy'], [2, 'echo-noid'], [3, 'echo-dead']] as Array<[number, string]>,
    slack: {
      getChannelRegistry: () => ({ C111: { sessionName: 'echo-claude' }, C222: { sessionName: 'echo-codex' } }),
      saveChannelResume: saveSlack,
      channelToSyntheticId: (id) => (id === 'C111' ? -111 : -222),
    },
    ...overrides,
  };
}

describe('buildResumeHeartbeatInput', () => {
  it('pairs every topic-linked session with its reported id AND framework; a session that is not running carries neither', () => {
    const input = buildResumeHeartbeatInput(deps());
    expect(input.get(61449)).toEqual({ sessionName: 'echo-claude', claudeSessionId: 'ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4', framework: 'claude-code' });
    expect(input.get(9210)).toEqual({ sessionName: 'echo-codex', claudeSessionId: '01a0de4a-bc5e-7761-a89d-e44faaeadb00', framework: 'codex-cli' });
    expect(input.get(1)).toEqual({ sessionName: 'echo-legacy', claudeSessionId: 'legacy-id', framework: undefined });
    expect(input.get(2)).toEqual({ sessionName: 'echo-noid', claudeSessionId: undefined, framework: 'claude-code' });
    expect(input.get(3)).toEqual({ sessionName: 'echo-dead', claudeSessionId: undefined, framework: undefined });
    expect(input.get(-111)?.framework).toBe('claude-code');
    expect(input.get(-222)?.framework).toBe('codex-cli');
  });

  it('works with Telegram only and with Slack only', () => {
    const tgOnly = buildResumeHeartbeatInput(deps({ slack: undefined }));
    expect([...tgOnly.keys()]).toEqual([61449, 9210, 1, 2, 3]);
    const slackOnly = buildResumeHeartbeatInput(deps({ telegramTopicSessions: undefined }));
    expect([...slackOnly.keys()]).toEqual([-111, -222]);
  });
});

describe('runResumeHeartbeatTick', () => {
  it('hands the framework-tagged set to refreshResumeMappings', () => {
    const d = deps();
    const enriched = runResumeHeartbeatTick(d);
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledWith(enriched);
    expect(enriched.get(61449)?.framework).toBe('claude-code');
  });

  it('writes a Slack channel resume only when the id resolves IN THE SESSION\'S framework layout', () => {
    const d = deps();
    runResumeHeartbeatTick(d);
    expect(d.exists).toHaveBeenCalledWith('ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4', 'claude-code');
    expect(d.exists).toHaveBeenCalledWith('01a0de4a-bc5e-7761-a89d-e44faaeadb00', 'codex-cli');
    expect(d.saveSlack).toHaveBeenCalledTimes(1);
    expect(d.saveSlack).toHaveBeenCalledWith('C111', 'ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4', 'echo-claude');
  });

  it('a channel whose session has no id never calls the transcript check', () => {
    const d = deps({ slack: { getChannelRegistry: () => ({ C333: { sessionName: 'echo-noid' } }), saveChannelResume: vi.fn(), channelToSyntheticId: () => -333 } });
    runResumeHeartbeatTick(d);
    expect(d.exists).not.toHaveBeenCalled();
  });
});

describe('production wiring (commands/server.ts source pins)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'server.ts'), 'utf8');

  it('the 60s resume heartbeat runs the extracted tick, not an inline copy', () => {
    const block = src.slice(src.indexOf('// Proactive resume heartbeat: every 60s'), src.indexOf("console.log(pc.green('  Resume heartbeat: active (60s interval)'))"));
    expect(block).toContain('runResumeHeartbeatTick({');
    expect(block).toContain('listRunningSessions: () => sessionManager.listRunningSessions()');
    expect(block).not.toContain('jsonlExistsPublic(session.claudeSessionId)');
    expect(src).toContain("import { runResumeHeartbeatTick } from '../core/ResumeHeartbeat.js';");
  });

  it('every save-before-kill lookup passes the session\'s framework', () => {
    const withFramework = (src.match(/findUuidForSession\([^)]*,\s*session\??\.framework\)/g) ?? []).length;
    expect(withFramework).toBe(6);
    expect(src).not.toMatch(/findUuidForSession\([^)]*session\??\.claudeSessionId \?\? undefined\)/);
  });

  it('the thread resume map resolves a thread session\'s framework from the session registry', () => {
    expect(src).toMatch(/new ThreadResumeMap\(config\.stateDir, config\.stateDir, undefined, undefined, \{[\s\S]{0,400}frameworkResolver: \(sessionName\) => state\.listSessions\(\)\.find\(\(s\) => s\.tmuxSession === sessionName\)\?\.framework/);
  });
});
