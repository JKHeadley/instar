/**
 * Agent awareness for Slack person mentions (Agent Awareness + Migration Parity).
 * New agents get the section from generateClaudeMd; existing agents get it once
 * from migrateClaudeMd; Slack sessions get the one-line version in their context.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PostUpdateMigrator,
  SLACK_MENTIONS_CLAUDEMD_MARKER,
  SLACK_MENTIONS_CLAUDEMD_SECTION,
  SLACK_MENTIONS_SESSION_LINE,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/slack-mentions-awareness.test.ts' });
});

describe('Slack person mentions awareness', () => {
  it('the guidance says how to tag, who gets tagged, what stays plain, and the override', () => {
    for (const text of [SLACK_MENTIONS_CLAUDEMD_SECTION(), SLACK_MENTIONS_SESSION_LINE]) {
      expect(text).toContain('<@U');
      expect(text).toMatch(/automatically/);
      expect(text).toMatch(/@here/);
      expect(text).toMatch(/code/);
      expect(text).toContain('--native-reference');
    }
    expect(SLACK_MENTIONS_CLAUDEMD_SECTION()).toContain('**When to use** (PROACTIVE)');
  });

  it('migrateClaudeMd adds the section to an existing agent exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mentions-mig-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n\nNative app conversations\n\nMy own note.\n');
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4321, hasTelegram: false, projectName: 'x' } as never);
    const result = { upgraded: [] as string[], errors: [] as string[], skipped: [] as string[] };
    (m as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
    const once = fs.readFileSync(file, 'utf8');
    (m as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd({ upgraded: [], errors: [], skipped: [] });
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    expect(once.split(SLACK_MENTIONS_CLAUDEMD_MARKER)).toHaveLength(2);
    expect(once).toContain('My own note.');
    expect(result.upgraded).toContain('CLAUDE.md: added Slack person mentions section');
  });

  it('a new agent CLAUDE.md template carries the section', async () => {
    const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
    const doc = (generateClaudeMd as (...a: unknown[]) => string)('x', 'agent', 4321, false);
    expect(doc).toContain(SLACK_MENTIONS_CLAUDEMD_MARKER);
  });
});
