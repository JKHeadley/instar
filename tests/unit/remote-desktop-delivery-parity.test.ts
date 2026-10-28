import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd, REMOTE_DESKTOP_MARKER } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CAPABILITY_INDEX } from '../../src/server/CapabilityIndex.js';

describe('native desktop init and migration parity', () => {
  it('advertises the same PIN-only path in self-discovery', () => {
    const desktop = CAPABILITY_INDEX.find(entry => entry.key === 'remoteDesktop');
    expect(desktop?.description).toContain('existing dashboard PIN');
    expect(desktop?.description).not.toContain('one-use code');
    expect(desktop?.description).not.toContain('fingerprint');
  });
  it('keeps new and existing agents dark while preserving a deliberate opt-in', () => {
    const defaults = getMigrationDefaults('managed-project');
    expect(defaults.remoteDesktop).toEqual({ enabled: false });
    const missing: Record<string, unknown> = {};
    applyDefaults(missing, defaults);
    expect(missing.remoteDesktop).toEqual({ enabled: false });
    const enabled: Record<string, unknown> = { remoteDesktop: { enabled: true } };
    applyDefaults(enabled, defaults);
    expect(enabled.remoteDesktop).toEqual({ enabled: true });
  });

  it('teaches fresh and updated agents the route and its limits exactly once', () => {
    const fresh = generateClaudeMd('test', 'Test', 4042, true);
    expect(fresh).toContain(REMOTE_DESKTOP_MARKER);
    expect(fresh).toContain('localhost:4042/desktop/availability');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-migration-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, '# Existing agent\n- Features: Real-time terminal streaming\n');
      const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'),
        port: 4042, projectName: 'test', hasTelegram: false });
      const run = () => (migrator as unknown as { migrateClaudeMd(result: { upgraded: string[]; skipped: string[]; errors: string[] }): void })
        .migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run();
      const first = fs.readFileSync(file, 'utf8');
      expect(first).toContain(REMOTE_DESKTOP_MARKER);
      run();
      expect(fs.readFileSync(file, 'utf8')).toBe(first);
      fs.writeFileSync(file, `# Existing agent\n- **${REMOTE_DESKTOP_MARKER}**: Opening requires a Telegram code.\n`);
      run();
      const updated = fs.readFileSync(file, 'utf8');
      expect(updated).toContain('no Telegram approval is required');
      expect(updated).not.toContain('Opening requires a Telegram code');
      run();
      expect(fs.readFileSync(file, 'utf8')).toBe(updated);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'remote-desktop-delivery-parity.test.ts cleanup' });
    }
  });
});
