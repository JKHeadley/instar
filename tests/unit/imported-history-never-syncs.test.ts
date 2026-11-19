/**
 * SEC-110: imported Claude/ChatGPT history stays on this machine.
 *
 * Every layer that decides what leaves the machine through git must refuse the
 * folder the ImportedHistoryStore writes: git sync's classifier (never-sync),
 * both .gitignore templates for new agents, and the update migration for
 * existing agents. The store's real folder is checked, so a rename of the
 * folder cannot silently slip past these lists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import { DEFAULT_GITIGNORE, GitStateManager } from '../../src/core/GitStateManager.js';
import { ensureGitignore } from '../../src/core/MachineIdentity.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import {
  IMPORTED_HISTORY_PROJECT_PATH,
  IMPORTED_HISTORY_STATE_PATH,
} from '../../src/core/importedHistoryPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('SEC-110: imported history never leaves the machine through git', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-sec110-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/imported-history-never-syncs.test.ts:cleanup' });
  });

  it('the shared path names the folder the store actually writes', () => {
    const store = new ImportedHistoryStore(stateDir);
    expect(path.relative(projectDir, store.dir) + '/').toBe(IMPORTED_HISTORY_PROJECT_PATH);
    expect(path.relative(stateDir, store.dir) + '/').toBe(IMPORTED_HISTORY_STATE_PATH);
  });

  it('git sync classifies every file under the folder as never-sync (relative and absolute paths)', () => {
    const classifier = new FileClassifier({ projectDir });
    const store = new ImportedHistoryStore(stateDir);
    const samples = [
      '.instar/imported-history/manifest.json',
      '.instar/imported-history/conversations/abc123.jsonl',
      '.instar/imported-history/attachments/photo.png',
      path.join(store.dir, 'conversations', 'abc123.jsonl'),
    ];
    for (const file of samples) {
      const result = classifier.classify(file);
      expect(result.strategy, file).toBe('never-sync');
    }
  });

  it('a neighbouring folder with a similar name is not swept up', () => {
    const classifier = new FileClassifier({ projectDir });
    expect(classifier.classify('.instar/imported-history-notes.md').strategy).not.toBe('never-sync');
  });

  it('a new agent home .gitignore lists the folder', () => {
    ensureGitignore(projectDir);
    const lines = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8').split('\n').map((l) => l.trim());
    expect(lines).toContain(IMPORTED_HISTORY_PROJECT_PATH);
  });

  it('a new internal state repo .gitignore lists the folder', () => {
    const lines = DEFAULT_GITIGNORE.split('\n').map((l) => l.trim());
    expect(lines).toContain(IMPORTED_HISTORY_STATE_PATH);
  });

  it('instar git init keeps imported history out of the first commit when a .gitignore already exists', () => {
    // One init path leaves project-relative lines in .instar/.gitignore, so
    // GitStateManager.init() would otherwise keep it as-is and run `git add -A`.
    ensureGitignore(stateDir);
    fs.mkdirSync(path.join(stateDir, 'imported-history', 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'imported-history', 'conversations', 'c1.jsonl'), '{"text":"private"}\n');
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# agent\n');
    const gsm = new GitStateManager(stateDir);
    gsm.init();
    const tracked = SafeGitExecutor.readSync(['ls-files'], { cwd: stateDir, encoding: 'utf8', operation: 'tests/unit/imported-history-never-syncs.test.ts:ls-files' }).split('\n');
    expect(tracked).toContain('AGENT.md');
    expect(tracked.some((f) => f.startsWith('imported-history/'))).toBe(false);
    const lines = fs.readFileSync(path.join(stateDir, '.gitignore'), 'utf-8').split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l === IMPORTED_HISTORY_STATE_PATH).length).toBe(1);
  });

  it('the update adds the line to existing .gitignore files once, and creates none', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/');
    fs.writeFileSync(path.join(stateDir, '.gitignore'), 'logs/\n');
    const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
    const run = (): MigrationResult => {
      const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
      (migrator as unknown as { migrateImportedHistoryGitignore(r: MigrationResult): void }).migrateImportedHistoryGitignore(r);
      return r;
    };
    const first = run();
    const second = run();
    expect(first.errors).toEqual([]);
    expect(first.upgraded.length).toBe(2);
    expect(second.upgraded).toEqual([]);
    const project = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
    const state = fs.readFileSync(path.join(stateDir, '.gitignore'), 'utf-8');
    expect(project.split('\n')).toContain('node_modules/');
    expect(project.split('\n').filter((l) => l.trim() === IMPORTED_HISTORY_PROJECT_PATH).length).toBe(1);
    expect(state.split('\n').filter((l) => l.trim() === IMPORTED_HISTORY_STATE_PATH).length).toBe(1);

    const bare = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-sec110-bare-'));
    try {
      fs.mkdirSync(path.join(bare, '.instar'));
      const bareMigrator = new PostUpdateMigrator({ projectDir: bare, stateDir: path.join(bare, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      (bareMigrator as unknown as { migrateImportedHistoryGitignore(r: MigrationResult): void }).migrateImportedHistoryGitignore({ upgraded: [], skipped: [], errors: [] });
      expect(fs.existsSync(path.join(bare, '.gitignore'))).toBe(false);
      expect(fs.existsSync(path.join(bare, '.instar', '.gitignore'))).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(bare, { recursive: true, force: true, operation: 'tests/unit/imported-history-never-syncs.test.ts:bare-cleanup' });
    }
  });
});
