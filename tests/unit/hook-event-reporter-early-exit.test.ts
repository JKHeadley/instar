/**
 * The update path must ship the same hook-event-reporter as `instar init`:
 * built-in hooks are overwritten on every update, so the migrator's copy is
 * what every existing agent runs. Both exit on the server's reply instead of
 * always waiting the 50 ms cap.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

describe('hook-event-reporter early exit (update path)', () => {
  it('the migrator-installed reporter exits on the reply and keeps the 50 ms cap', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-early-exit-'));
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const script = (m as unknown as { getHookEventReporterScript(): string }).getHookEventReporterScript();
    expect(script).toContain("res.on('end', () => process.exit(0))");
    expect(script).toContain("req.on('error', () => process.exit(0))");
    expect(script).toContain('setTimeout(() => process.exit(0), 50)');
  });
});
