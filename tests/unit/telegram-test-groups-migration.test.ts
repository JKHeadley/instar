import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginTestGroupsAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// docs/specs/telegram-test-groups.md section 9 — new and existing agents learn the routes.
const OLD = 'An enrolled operator Telegram browser profile exposes only typed operations: `GET /telegram/browser/PROFILE/snapshot` and `POST /telegram/browser/PROFILE/send`.';
describe('Telegram test groups awareness installation parity', () => {
  it('new agents learn the routes and the broker sentence names them', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(telegramOriginTestGroupsAwareness());
    expect(md).toContain('/telegram/browser/PROFILE/test-groups');
    expect(md).not.toContain(OLD);
  });
  it('existing agents receive it once, the old sentence is refreshed, and Codex/Gemini instructions mirror it', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-groups-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, `# Existing custom instructions\n${OLD}\n`);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), `# Custom framework instructions\n${OLD}\n`);
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1720' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split('Telegram test groups:')).toHaveLength(2);
      expect(text).not.toContain(OLD);
      const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('Telegram test groups:');
      expect(agents).not.toContain(OLD);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:test-groups-migration:cleanup' });
    }
  });
});
