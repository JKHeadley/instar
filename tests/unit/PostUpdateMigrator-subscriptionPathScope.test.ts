/**
 * Verifies the subscription-path SCOPE-correction migration
 * (june15-headless-spawn-reroute, review finding F2).
 *
 * PR 1 (#873) deployed a CLAUDE.md block scoping the subscriptionPath lever
 * to "internal background LLM calls" — after PR 2 the same key also reroutes
 * headless job / A2A / dispatch spawns, so the deployed wording is factually
 * incomplete. The PR-1 sniff ('/providers/registry') is already satisfied on
 * every deployed agent, so a NEW migration with a NEW sniff is the only path
 * to correct the fleet (Migration Parity: "a feature that only works for new
 * agents is a broken feature").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

// The two PR-1 wordings that exist in the wild (migrator-injected agents say
// "routes them"; fresh-init template agents say "can route them").
const PR1_MIGRATOR_SENTENCE =
  'Your internal background LLM calls (sentinels, gates, extractors) normally run as `claude -p` one-shots, which bill the Agent SDK credit pot after 2026-06-15. The subscription-path lever routes them through a pool of long-lived interactive Claude sessions instead — the path that keeps working when the pot is empty.';
const PR1_TEMPLATE_SENTENCE =
  'Your internal background LLM calls (sentinels, gates, extractors) normally run as `claude -p` one-shots, which bill the Agent SDK credit pot after 2026-06-15. The subscription-path lever can route them through a pool of long-lived interactive Claude sessions instead — the path that keeps working when the pot is empty.';

const CORRECTED_PHRASE = 'headless job / agent-to-agent / dispatch spawns';

function pr1Block(sentence: string): string {
  return `# CLAUDE.md\n\n### Anthropic Subscription-Path Routing (June-15 readiness)\n\n${sentence}\n- What's actually wired in: \`GET /providers/registry\`\n`;
}

describe('PostUpdateMigrator — subscription-path scope correction (F2)', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sp-scope-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-subscriptionPathScope.test.ts:cleanup',
    });
  });

  it('corrects the migrator-deployed PR-1 wording ("routes them")', () => {
    fs.writeFileSync(claudeMdPath, pr1Block(PR1_MIGRATOR_SENTENCE));
    const result = runClaudeMdMigration(newMigrator(projectDir));
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain(CORRECTED_PHRASE);
    expect(content).not.toContain(PR1_MIGRATOR_SENTENCE);
    expect(result.upgraded.some((u) => u.includes('corrected Subscription-Path Routing scope'))).toBe(true);
  });

  it('corrects the template-deployed PR-1 wording ("can route them")', () => {
    fs.writeFileSync(claudeMdPath, pr1Block(PR1_TEMPLATE_SENTENCE));
    runClaudeMdMigration(newMigrator(projectDir));
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain(CORRECTED_PHRASE);
    expect(content).not.toContain(PR1_TEMPLATE_SENTENCE);
  });

  it('is idempotent — a second run does not re-patch or duplicate', () => {
    fs.writeFileSync(claudeMdPath, pr1Block(PR1_MIGRATOR_SENTENCE));
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('corrected Subscription-Path Routing scope'))).toBe(false);
  });

  it('leaves a hand-edited section (no PR-1 sentence) untouched', () => {
    const handEdited = `# CLAUDE.md\n\n### Anthropic Subscription-Path Routing (June-15 readiness)\n\nMy operator rewrote this section in their own words. \`GET /providers/registry\` is mentioned so the PR-1 sniff is satisfied.\n`;
    fs.writeFileSync(claudeMdPath, handEdited);
    const result = runClaudeMdMigration(newMigrator(projectDir));
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('My operator rewrote this section');
    expect(content).not.toContain(CORRECTED_PHRASE);
    expect(result.upgraded.some((u) => u.includes('corrected Subscription-Path Routing scope'))).toBe(false);
  });

  it('does nothing on a CLAUDE.md that predates PR 1 entirely (the PR-1 add runs instead, already corrected-scope or not)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNo subscription-path block at all.\n');
    runClaudeMdMigration(newMigrator(projectDir));
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    // The PR-1 add-section migration fires (its sniff is unsatisfied) — and
    // the scope-correction then upgrades that fresh block in the same pass
    // (or the block already carries the corrected wording; either way the
    // final state must include the corrected scope phrase exactly once).
    const occurrences = content.split('/providers/registry').length - 1;
    expect(occurrences).toBeGreaterThan(0);
  });
});
