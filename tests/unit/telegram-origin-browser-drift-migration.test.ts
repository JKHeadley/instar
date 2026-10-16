import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginBrowserDriftAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Telegram Web K drift awareness installation parity', () => {
  it('new agents learn the hold, the attention item and the reviewed re-enrollment entrypoint', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(telegramOriginBrowserDriftAwareness());
    expect(md).toContain('instar telegram-origin enroll-browser <profile>');
    expect(md).toContain('one attention item per failed build.');
    expect(md).not.toContain('one attention item per episode.');
  });
  it('existing agents receive it idempotently and the old per-episode wording is corrected', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webk-drift-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042 }));
    fs.writeFileSync(md, '# Existing custom instructions\nA failed browser canary gets one fresh-process retry, then a persisted 15-minute pause and one attention item per episode.\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1355' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split('Telegram Web K updates:')).toHaveLength(2);
      expect(text).not.toContain('one attention item per episode.');
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Telegram Web K updates:');
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:webk-drift-migration:cleanup' });
    }
  });
});
