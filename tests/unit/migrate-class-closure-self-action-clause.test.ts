/**
 * Unit tests for migrateClassClosureTemplateSelfActionClause (Part E5) — updates
 * the deployed instar-dev side-effects template so EXISTING agents get the
 * self-action clause in the Class-Closure Declaration trigger note (Migration
 * Parity). Idempotent; leaves a customized template untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;

function makeMigrator(): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function emptyResult() {
  return { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
}

const TEMPLATE_REL = ['.claude', 'skills', 'instar-dev', 'templates', 'side-effects-artifact.md'];

function writeTemplate(content: string): string {
  const file = path.join(projectDir, ...TEMPLATE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const run = (result: ReturnType<typeof emptyResult>) =>
  (makeMigrator() as unknown as { migrateClassClosureTemplateSelfActionClause: (r: typeof result) => void })
    .migrateClassClosureTemplateSelfActionClause(result);

// A stock template that HAS the Class-Closure Declaration section but LACKS the
// self-action clause (the pre-E5 state).
const STOCK_BEFORE = `# Side-Effects Review

## Class-Closure Declaration (display-only mirror)

**REQUIRED whenever this change FIXES a defect in an agent-authored artifact** (an
LLM prompt, hook, config, skill, or standards text). This section is the mirror.
`;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-selfaction-clause-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/migrate-class-closure-self-action-clause.test.ts',
  });
});

describe('migrateClassClosureTemplateSelfActionClause', () => {
  it('adds the self-action clause to a stock template that lacks it', () => {
    const file = writeTemplate(STOCK_BEFORE);
    const result = emptyResult();
    run(result);
    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('unbounded-self-action');
    expect(result.upgraded.some((u) => /Class-Closure self-action clause/.test(u))).toBe(true);
  });

  it('is idempotent — a template that already has the clause is untouched', () => {
    const file = writeTemplate(`${STOCK_BEFORE}\nSee the unbounded-self-action class.\n`);
    const before = fs.readFileSync(file, 'utf8');
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(result.upgraded).toHaveLength(0);
  });

  it('leaves a customized template (no Class-Closure fingerprint) untouched', () => {
    const file = writeTemplate('# My custom side-effects template\n\nNothing standard here.\n');
    const before = fs.readFileSync(file, 'utf8');
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(result.skipped.some((s) => /left untouched/.test(s))).toBe(true);
  });

  it('no deployed template → no-op (fresh installs get the bundled copy)', () => {
    const result = emptyResult();
    expect(() => run(result)).not.toThrow();
    expect(result.upgraded).toHaveLength(0);
  });
});
