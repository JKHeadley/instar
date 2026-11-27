import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('feedback review routing awareness migration', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-review-routing-test' }); });

  it('adds the model policy once for an existing agent', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-review-md-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n\n**Feedback executor (operated feedback factory)**\n\n**Session Clock** — details\n');
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
    run(); run();
    const after = fs.readFileSync(file, 'utf8');
    expect(after.split('**Feedback review model routing**')).toHaveLength(2);
    expect(after).toContain('GPT-6 Astra');
    expect(after).toContain('Claude Opus 5.5');
    expect(after.indexOf('**Feedback review model routing**')).toBeLessThan(after.indexOf('**Session Clock**'));
  });
});
