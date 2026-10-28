import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginHeldOutcomeAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('held-reply outcome awareness installation parity', () => {
  it('new agents learn the lookup and the do-not-resend rule', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(telegramOriginHeldOutcomeAwareness());
    expect(md).toContain('/telegram/origins/operations/OPERATION_ID/outcome');
  });
  it('existing agents receive it once, in CLAUDE.md and the framework shadow', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-outcome-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042 }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1480' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split('Held reply outcome:')).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split('Held reply outcome:')).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:held-outcome-migration:cleanup' });
    }
  });
});
