/**
 * native-conversation-any-machine-access §3e — agent awareness and migration parity for the
 * dashboard reply box: new agents learn what the `[dashboard]` line means and how to answer
 * it, existing agents receive the same paragraph once, in CLAUDE.md and the framework shadow.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { dashboardInputAwareness, DASHBOARD_INPUT_AWARENESS_MARKER } from '../../src/server/dashboardInputAwareness.js';
import { sessionLine } from '../../dashboard/console/input-model.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('dashboard reply box awareness', () => {
  it('new agents, with or without Telegram, learn how to answer the [dashboard] line', () => {
    for (const hasTelegram of [true, false]) {
      const md = generateClaudeMd('echo', 'Echo', 4042, hasTelegram);
      expect(md).toContain(dashboardInputAwareness());
    }
    for (const phrase of ['[dashboard] A message typed in the dashboard at HH:MM', 'say only that you cannot confirm it', 'Never say it was lost', 'GET /sessions/dashboard-input-status', 'dashboard.poolStream.allowRemoteInput']) {
      expect(dashboardInputAwareness()).toContain(phrase);
    }
  });

  it('the paragraph quotes the start of the line the console really sends', () => {
    const real = sessionLine(Date.now(), 'abcdefghijklmnop');
    expect(real.startsWith('[dashboard] A message typed in the dashboard at ')).toBe(true);
    expect(real).toContain('could not be confirmed');
  });

  it('existing agents receive it once, in CLAUDE.md and the framework shadow', () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'dashboard-input-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1740' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split(DASHBOARD_INPUT_AWARENESS_MARKER)).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split(DASHBOARD_INPUT_AWARENESS_MARKER)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:dashboard-input-migration:cleanup' });
    }
  });
});
