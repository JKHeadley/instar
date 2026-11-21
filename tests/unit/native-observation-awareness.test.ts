import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd, remoteDesktopBullet } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('native observation agent awareness', () => {
  it('new agents learn the diagnostic limits, and existing agents receive the same bullet idempotently', () => {
    expect(generateClaudeMd('echo', 'Echo', 4042, true)).toContain('guardObservation');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-awareness-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    const filename = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(filename, '# Custom instructions\n- **Native Remote Desktop**: old diagnostic text\n');
    try {
      const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4042, hasTelegram: true, projectName: 'echo' });
      const run = () => (migrator as any).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run();
      const first = fs.readFileSync(filename, 'utf8');
      expect(first).toContain(remoteDesktopBullet(4042));
      expect(first).toContain('# Custom instructions');
      run();
      const second = fs.readFileSync(filename, 'utf8');
      expect(second.split('guardObservation')).toHaveLength(2);
      expect(second).toBe(first);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'awareness fixture cleanup' }); }
  });
});
