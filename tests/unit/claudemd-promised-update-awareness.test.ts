// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Agent Awareness + Migration Parity for promised-update capture
 * (docs/specs/promised-update-capture.md): new agents get the line from the
 * template, existing agents get it from the migrator — once.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const templateSrc = fs.readFileSync(path.join(ROOT, 'src/scaffold/templates.ts'), 'utf-8');

function migrate(claudeMd: string): { out: string; upgraded: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promised-update-migrate-'));
  try {
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, claudeMd);
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(result);
    return { out: fs.readFileSync(file, 'utf-8'), upgraded: result.upgraded };
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/claudemd-promised-update-awareness.test.ts' });
  }
}

const MARKER = '- **When to use** (PROACTIVE — this is the trigger): the moment you promise the user a future action, open a commitment.';

describe('promised-update capture awareness', () => {
  it('the template tells a new agent about it, with the off switch', () => {
    expect(templateSrc).toContain('promised-update capture');
    expect(templateSrc).toContain('commitments.promisedUpdateCapture.enabled');
  });

  it('an existing agent with the Commitments section gets the line, before the trigger line', () => {
    const { out, upgraded } = migrate(`# Agent\n\n**Commitments & Follow-Through** — x\n- /commitments/check-in-reminder\n${MARKER}\n`);
    expect(out).toContain('promised-update capture');
    expect(out.indexOf('promised-update capture')).toBeLessThan(out.indexOf(MARKER));
    expect(upgraded).toContain('CLAUDE.md: added promised-update capture to Commitments section');
  });

  it('is idempotent', () => {
    const once = migrate(`# Agent\n\n**Commitments & Follow-Through** — x\n- /commitments/check-in-reminder\n${MARKER}\n`).out;
    const twice = migrate(once).out;
    expect(twice).toBe(once);
    expect(twice.split('promised-update capture').length - 1).toBe(1);
  });

  it('appends when the trigger line has drifted, rather than skipping', () => {
    const { out } = migrate(`# Agent\n\n**Commitments & Follow-Through** — x\n- /commitments/check-in-reminder\n- my own wording\n\n## Next\n`);
    expect(out).toContain('promised-update capture');
  });
});
