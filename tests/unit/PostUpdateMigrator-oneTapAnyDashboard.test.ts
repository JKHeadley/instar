// Operator rule 2026-11-10 (topic 33890): every action for the agent from any machine's dashboard.
// Existing agents carry the one-tap bullet that said another machine could never raise a machine's
// repair setting; the migration rewords it, once, and leaves other text alone.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'oneTapAnyDashboard cleanup' });
});

const OLD_BULLET = "- **One-tap repair setting (Accounts page)** — the console Accounts page has an **Automatic sign-in repair** section. After one PIN unlock, **Turn on for ticked machines** sets the operator's own machine to repair without asking and refreshes the account list of any other machine already set that way; **Switch ticked machines back to asking first** undoes it. A machine set to \"asks you first\", watching only, or off is never escalated from another machine. It reads things.";
const LABEL = 'CLAUDE.md: one-tap repair setting now works for every machine from any dashboard';

function migrate(root: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('one-tap repair bullet: any dashboard, any machine', () => {
  it('rewords an installed old bullet once, and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onetap-any-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    const target = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(target, `# CLAUDE.md\n\n${OLD_BULLET}\n`);
    const first = migrate(root);
    expect(first.upgraded).toContain(LABEL);
    const once = fs.readFileSync(target, 'utf8');
    expect(once).not.toContain('is never escalated from another machine');
    expect(once).not.toContain("sets the operator's own machine to repair without asking");
    expect(once).toContain("Any machine's dashboard can do this for every paired machine");
    expect(once).toContain('**Switch ticked machines back to asking first** undoes it');
    const second = migrate(root);
    expect(second.upgraded).not.toContain(LABEL);
    expect(fs.readFileSync(target, 'utf8')).toBe(once);
  });

  it('leaves a CLAUDE.md without the old bullet untouched by this step', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onetap-any-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md\n\nNothing about repair here.\n');
    expect(migrate(root).upgraded).not.toContain(LABEL);
  });

  it('fresh agents get the new wording from the template', () => {
    const content = generateClaudeMd('test', 'Scout', 4042, true);
    if (content.includes('One-tap repair setting (Accounts page)')) {
      expect(content).toContain("Any machine's dashboard can do this for every paired machine");
      expect(content).not.toContain('is never escalated from another machine');
    }
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'scaffold', 'templates.ts'), 'utf8');
    expect(src).not.toContain('is never escalated from another machine');
  });
});
