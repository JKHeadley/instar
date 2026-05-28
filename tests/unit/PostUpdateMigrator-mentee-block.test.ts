/**
 * Tier-1 unit test for the mentee-block migration parity invariant.
 *
 * The mentee receiver wiring lives in `config.mentee`. Migration parity
 * (CLAUDE.md non-negotiable) requires that existing agents — whose
 * config.json predates the mentee block — receive the block on the next
 * `instar` update. The mechanism is the canonical `applyDefaults` pass
 * in `migrateConfig` which reads `ConfigDefaults.ts` and backfills missing
 * keys. This test proves that path:
 *   1. An agent with no `mentee` block at all → mentee.* keys added.
 *   2. An agent with a PARTIAL mentee block → only the missing sub-keys are
 *      added; existing values are left alone (no surprise overwrite).
 *   3. Idempotent: a second migration is a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function buildMigrator(projectDir: string): PostUpdateMigrator {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function writeConfig(stateDir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2));
}

function readConfig(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
}

describe('PostUpdateMigrator: mentee block backfill (migration parity)', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mentee-mig-'));
    stateDir = path.join(projectDir, '.instar');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'mentee-migration test' });
  });

  it('adds the mentee block (with safe-dormant defaults) when missing from an existing agent', async () => {
    // Simulate an agent whose config.json predates the mentee block.
    writeConfig(stateDir, {
      projectName: 'pre-mentee-agent',
      port: 4040,
      authToken: 'abc',
      // NO mentee block here
    });
    const m = buildMigrator(projectDir);
    await (m as unknown as { migrate: () => Promise<unknown> }).migrate();

    const post = readConfig(stateDir);
    expect(post.mentee).toBeDefined();
    const mentee = post.mentee as Record<string, unknown>;
    expect(mentee.enabled).toBe(false); // ships-dormant invariant survives migration
    expect(mentee.localAgentName).toBe('');
    expect(mentee.knownMentors).toEqual({});
    expect(mentee.replyChatId).toBe('');
    expect(mentee.replyTopicId).toBe(0);
    expect(mentee.sessionTimeoutMs).toBe(300_000);
  });

  it('PRESERVES existing user values in a partial mentee block — only missing sub-keys are backfilled', async () => {
    // An agent who already enabled mentee + set their own localAgentName before
    // a newer field was added must keep those values; new fields backfill.
    writeConfig(stateDir, {
      projectName: 'partial-mentee-agent',
      port: 4040,
      authToken: 'abc',
      mentee: {
        enabled: true,
        localAgentName: 'instar-codey',
        knownMentors: { echo: { botId: '8781020500' } },
        // replyChatId / replyTopicId / sessionTimeoutMs missing
      },
    });
    const m = buildMigrator(projectDir);
    await (m as unknown as { migrate: () => Promise<unknown> }).migrate();

    const post = readConfig(stateDir);
    const mentee = post.mentee as Record<string, unknown>;
    // Preserved
    expect(mentee.enabled).toBe(true);
    expect(mentee.localAgentName).toBe('instar-codey');
    expect(mentee.knownMentors).toEqual({ echo: { botId: '8781020500' } });
    // Backfilled
    expect(mentee.replyChatId).toBe('');
    expect(mentee.replyTopicId).toBe(0);
    expect(mentee.sessionTimeoutMs).toBe(300_000);
  });

  it('IDEMPOTENT: a second migration leaves the mentee block exactly as the first migration produced it', async () => {
    writeConfig(stateDir, { projectName: 'idempotent-agent', port: 4040, authToken: 'abc' });
    const m1 = buildMigrator(projectDir);
    await (m1 as unknown as { migrate: () => Promise<unknown> }).migrate();
    const after1 = JSON.stringify(readConfig(stateDir).mentee);

    const m2 = buildMigrator(projectDir);
    await (m2 as unknown as { migrate: () => Promise<unknown> }).migrate();
    const after2 = JSON.stringify(readConfig(stateDir).mentee);

    expect(after2).toBe(after1);
  });
});
