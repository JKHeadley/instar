/**
 * Class closure for spec cloud-key-internal-calls: every server-side place that starts `claude`
 * either hands it the configured key or says why it needn't. A new launch site fails here until it
 * chooses, so the gap cannot quietly come back on one more lane.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

const EXEMPT: Record<string, string> = {
  'src/core/Prerequisites.ts': '--version only, no model call',
  'src/core/crossModelReviewer.ts': '--help only; its model calls go through ClaudeCliIntelligenceProvider',
  'src/feedback-factory/execute/buildFeedbackExecutor.ts': '--version only',
  'src/core/claudeKeyProbe.ts': 'passes the key under test explicitly',
  'src/core/ClaudeBinaryRetainer.ts': '--version only',
  'src/ecosystem/buildEcosystemIdeas.ts': '--version only; its model calls go through the provider',
  'src/commands/server.ts': 'matches unrelated generic exec helpers; the login panes need no key',
  'src/commands/setup.ts': 'matches a loginctl helper; setup runs before any key exists',
  'src/core/SessionManager.ts': 'launches through tmux; covered by the lane test below',
  'src/providers/adapters/anthropic-headless/transport/agenticSessionHeadless.ts': 'opt-in adapter, tmux -e only; Frontloaded Decision 5',
  'src/providers/adapters/anthropic-interactive-pool/pool.ts': 'opt-in adapter, tmux -e only; Frontloaded Decision 5',
};

const LAUNCH = /(?:execFile|execFileAsync|execFileSync|spawn|spawnSync)\(\s*(?:this\.config\.|this\.|config\.[\w?.]*|inputs?\.)?(?:claudePath|bin\b|cmd\b)|args\.push\(this\.config\.claudePath|tmuxArgs\.push\(this\.config\.claudePath|\$\{claudePath\}|buildHeadlessLaunch\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('every claude launch gets the configured key or says why not', () => {
  const files = walk(path.join(ROOT, 'src'))
    .map((file) => ({ rel: path.relative(ROOT, file), source: stripComments(fs.readFileSync(file, 'utf-8')) }))
    .filter(({ source }) => /claude/i.test(source) && LAUNCH.test(source));

  it('finds the launch sites, so a broken matcher cannot pass by finding nothing', () => {
    const found = files.map((f) => f.rel);
    for (const site of ['src/core/ClaudeCliIntelligenceProvider.ts', 'src/core/ProjectRoundExecution.ts', 'src/threadline/PipeSessionSpawner.ts', 'src/lifeline/TelegramLifeline.ts']) {
      expect(found).toContain(site);
    }
  });

  it('each one uses the helper or is on the exempt list', () => {
    const uncovered = files
      .filter(({ rel, source }) => !(rel in EXEMPT) && !/applyClaudeChildAuth|writeClaudeAuthEnvFile/.test(source))
      .filter(({ source }) => /claude/i.test(source) && /claudePath|claude-code/.test(source))
      .map((f) => f.rel);
    const notClaude = new Set(['src/core/frameworkSessionLaunch.ts', 'src/core/nativeHookEventsGate.ts']);
    expect(uncovered.filter((f) => !notClaude.has(f))).toEqual([]);
  });

  it('all four session lanes in SessionManager carry the key', () => {
    const source = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/SessionManager.ts'), 'utf-8'));
    const direct = source.match(/CLAUDE_CODE_OAUTH_TOKEN=\$\{this\.config\.anthropicApiKey\}/g) ?? [];
    expect(direct).toHaveLength(3);
    expect(source).toContain('claudeAuthExecPrefix(triageAuthFile)');
  });

  it('no new lane puts the key in argv', () => {
    for (const rel of ['src/threadline/PipeSessionSpawner.ts', 'src/lifeline/TelegramLifeline.ts', 'src/core/ClaudeKeyHealth.ts', 'src/core/claudeKeyProbe.ts']) {
      const source = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
      expect(source, rel).not.toMatch(/-e['"`,\s]+[`'"]?CLAUDE_CODE_OAUTH_TOKEN/);
      expect(source, rel).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN=\$\{/);
    }
  });
});
