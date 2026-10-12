/**
 * Migration Parity — an agent that ALREADY has the tone-advisory section must
 * still receive the reaction INVOCATION (the flags, and that they precede the
 * topic id).
 *
 * This is the case that is easy to get wrong, and the reason this test exists.
 * The tone-advisory CLAUDE.md block was historically content-sniffed on the marker
 * 'Most checks are NUDGES you may override'. Existing installs carrying that
 * legacy block still need the independently-sniffed invocation guidance. So
 * appending the invocation guidance to that constant reaches NEW installs only
 * — every already-deployed agent short-circuits on the unchanged marker and
 * receives nothing. A doc fix that only lands on fresh installs is not a fix;
 * it is the "works for new agents only" broken-feature shape the Migration
 * Parity Standard exists to prevent.
 *
 * Hence a SECOND, independently-sniffed block keyed on its own marker.
 *
 * Why it matters concretely: the advisory section documents `metadata.*` — the
 * HTTP shape — while the agent template mandates the relay SCRIPT ("ALWAYS the
 * relay script, never a hand-rolled curl"). The flags bridging the two were
 * documented nowhere, so an agent handed a decisionRef had to invent the
 * invocation. A flag placed after the topic id was silently swallowed into the
 * message body, sent to the user as literal text, and its override dropped —
 * which is how a CORRECT tone-gate check came to be graded `wrong` on
 * 2026-07-26.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  TONE_ADVISORY_MIGRATION_CLAUDEMD_SECTION,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const MARKER = 'EVERY FLAG GOES BEFORE THE TOPIC ID';

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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('PostUpdateMigrator — tone-advisory reaction invocation (flag position)', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tone-flag-pos-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-toneAdvisoryFlagPosition.test.ts:cleanup',
    });
  });

  it('THE LOAD-BEARING CASE: an agent that already has the advisory section still receives the invocation', () => {
    // Simulate a deployed agent: it carries the tone-advisory section already,
    // so the block that section lives in will short-circuit on its unchanged
    // marker. Only an independently-sniffed block can reach this agent.
    const deployed = `# CLAUDE.md\n\nMy existing config.\n\n${TONE_ADVISORY_MIGRATION_CLAUDEMD_SECTION}\n`;
    // Guard the premise: strip any invocation guidance so we are genuinely
    // reproducing the pre-fix on-disk state rather than a file that already
    // contains the answer.
    const preFix = deployed.split(MARKER).join('(invocation guidance absent)');
    expect(preFix).toContain('File-path feedback is always a NUDGE');
    expect(preFix).not.toContain(MARKER);
    fs.writeFileSync(claudeMdPath, preFix);

    const result = runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result.errors).toEqual([]);
    expect(after).toContain(MARKER);
    expect(result.upgraded.some((u) => u.includes('tone-advisory reaction invocation'))).toBe(true);

    // And it must teach the actual invocation, not merely mention ordering.
    expect(after).toContain('--tone-ack');
    expect(after).toContain('--tone-reason');
    expect(after).toContain('telegram-reply.sh');
  });

  it('replaces the legacy advisory block so existing agents learn that file paths never hard-block', () => {
    const legacy = `### Outbound Tone Gate\n\n**Most checks are NUDGES you may override — two things are walls.** Under the advisory migration, file paths are advisory.\n\n### Next Section\n`;
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${legacy}`);

    const result = runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result.errors).toEqual([]);
    expect(after).toContain('File-path feedback is always a NUDGE');
    expect(after).toContain('even when decision-quality recording is unavailable');
    expect(after).not.toContain('Most checks are NUDGES you may override');
    expect(after).toContain('### Next Section');
  });

  it('is idempotent — a second run adds nothing and does not duplicate', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing config.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(result2.upgraded.some((u) => u.includes('tone-advisory reaction invocation'))).toBe(false);
  });

  it('a fresh CLAUDE.md gets the guidance exactly once, not once per path', () => {
    // The advisory section now embeds the invocation, and a separate block also
    // appends it. A fresh install must not end up with both.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing config.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(occurrences(after, MARKER)).toBe(1);
  });
});
