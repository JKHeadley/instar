import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramDashboardEditAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('dashboard edit rejection installation parity', () => {
  it('informs newly generated agents of the failure response and original-operation custody', () => {
    expect(generateClaudeMd('echo', 'Echo', 4042, true)).toContain(telegramDashboardEditAwareness());
  });
  it.each([false, true])('updates an existing agent idempotently (already present: %s)', alreadyPresent => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-edit-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042 }));
    fs.writeFileSync(md, '# Existing custom instructions\n' + (alreadyPresent ? telegramDashboardEditAwareness() : ''));
    for (const shadow of ['AGENTS.md', 'GEMINI.md']) fs.writeFileSync(path.join(projectDir, shadow), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1235' }).migrate();
      migrate(); const first = fs.readFileSync(md, 'utf8');
      expect(first).toContain('# Existing custom instructions');
      expect(first).toContain(telegramDashboardEditAwareness());
      migrate(); const second = fs.readFileSync(md, 'utf8');
      expect(second.split('Dashboard edit rejection:')).toHaveLength(2);
      expect(second).toContain(telegramDashboardEditAwareness());
      for (const shadow of ['AGENTS.md', 'GEMINI.md']) {
        const text = fs.readFileSync(path.join(projectDir, shadow), 'utf8');
        expect(text).toContain('# Custom framework instructions');
        expect(text).toContain(telegramDashboardEditAwareness());
      }
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:dashboard-edit-migration:cleanup' });
    }
  });
});
