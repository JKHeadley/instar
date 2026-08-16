/**
 * Drift guard for the telegram-topic-context.sh hook.
 *
 * There are two copies of this hook in the repo:
 *   - src/templates/hooks/telegram-topic-context.sh (canonical file)
 *   - PostUpdateMigrator.getTelegramTopicContextHook() (inline string,
 *     installed by migrateHooks on every PostUpdateMigrator pass)
 *
 * They MUST emit the same bytes. Without this test, an edit to one without
 * the other silently ships drifted behavior to the fleet — exactly what
 * happened with the topic-intent briefing fetch (canonical had it; inline
 * did not; existing agents had it silently stripped on every update). Per
 * Structure > Willpower, the rule that "edits to one must update the
 * other" is enforced HERE — not as a comment future-us is asked to
 * remember.
 *
 * Spec: docs/specs/topic-intent-briefing-injection.md (FAIL-mac-lan-001).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../src/templates/hooks/telegram-topic-context.sh',
);

function newMigrator(): PostUpdateMigrator {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-drift-guard-'));
  return new PostUpdateMigrator({
    projectDir: stateDir,
    stateDir: path.join(stateDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'drift-guard',
  });
}

describe('PostUpdateMigrator — telegram-topic-context drift guard', () => {
  it('the canonical template file exists', () => {
    expect(fs.existsSync(TEMPLATE_PATH)).toBe(true);
    const stat = fs.statSync(TEMPLATE_PATH);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('the inline content includes the topic-intent briefing fetch (both auth branches)', () => {
    const migrator = newMigrator();
    const inline = (migrator as unknown as {
      getTelegramTopicContextHook(): string;
    }).getTelegramTopicContextHook();
    // The specific failure: prior versions of the inline content did NOT
    // call /topic-intent/:id/briefing — that's the bug this spec fixes.
    const matches = inline.match(/topic-intent\/\$\{TOPIC_ID\}\/briefing/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2); // auth + no-auth branch
  });

  it('the canonical template includes the topic-intent briefing fetch', () => {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(template).toMatch(/topic-intent\/\$\{TOPIC_ID\}\/briefing/);
  });

  it('the inline content matches the canonical template byte-for-byte (after trim)', () => {
    const migrator = newMigrator();
    const inline = (migrator as unknown as {
      getTelegramTopicContextHook(): string;
    }).getTelegramTopicContextHook();
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    // Per the spec: byte-equality (or content-equivalence after trimming).
    // If this fails, the two copies have drifted; sync the migrator's
    // inline content to match src/templates/hooks/telegram-topic-context.sh.
    expect(inline.trim()).toBe(template.trim());
  });
});
