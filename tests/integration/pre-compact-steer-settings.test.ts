/**
 * context-budget-layered-summaries §9.1 — the PreCompact steering entry through
 * the real settings pipeline: migrateSettings adds it once (idempotent), next to
 * the event reporter's PreCompact entry, and the reporter/native-events
 * reconciliation in BOTH directions leaves it in place (§9.1: "left alone by the
 * reporter and native-events migrations"). An operator's own PreCompact hook is
 * kept.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { reconcileReporterHooks, REPORTER_COMMAND_HOOK } from '../../src/data/http-hook-templates.js';

type Entry = { matcher?: string; hooks: Array<{ type?: string; command?: string; url?: string }> };

describe('PreCompact steering entry — settings pipeline', () => {
  let home: string;
  let stateDir: string;
  let settingsPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-settings-'));
    stateDir = path.join(home, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4321 }));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    settingsPath = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {
      PreCompact: [
        { matcher: '', hooks: [{ ...REPORTER_COMMAND_HOOK }] },
        { matcher: 'manual', hooks: [{ type: 'command', command: 'echo operator-own' }] },
      ],
    } }));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/pre-compact-steer-settings.test.ts' }));

  const migrate = () => {
    const m = new PostUpdateMigrator({ projectDir: home, stateDir, port: 4321, hasTelegram: false, projectName: 't' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateSettings(r: typeof result): void }).migrateSettings(result);
    return result;
  };
  const preCompact = (): Entry[] => JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks.PreCompact;
  const steer = (es: Entry[]) => es.filter(e => e.hooks.some(h => h.command?.includes('pre-compact-steer.sh')));

  it('adds exactly one steering entry, keeps the reporter and the operator hook, and is idempotent', () => {
    const r1 = migrate();
    expect(r1.upgraded.some(u => u.includes('PreCompact steering hook'))).toBe(true);
    migrate();
    const es = preCompact();
    expect(steer(es)).toHaveLength(1);
    expect(steer(es)[0]).toMatchObject({ matcher: '', hooks: [{ type: 'command', timeout: 5 }] });
    expect(es.some(e => e.hooks.some(h => h.command?.includes('hook-event-reporter')))).toBe(true);
    expect(es.some(e => e.hooks.some(h => h.command === 'echo operator-own'))).toBe(true);
  });

  it('survives reporter reconciliation to native and back', () => {
    migrate();
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(reconcileReporterHooks(settings.hooks, { native: true, baseUrl: 'http://127.0.0.1:4321' })).toBe(true); // positive control: it did rewrite
    expect((settings.hooks.PreCompact as Entry[]).some(e => e.hooks.some(h => h.type === 'http'))).toBe(true);
    expect(steer(settings.hooks.PreCompact)).toHaveLength(1);
    expect(reconcileReporterHooks(settings.hooks, { native: false })).toBe(true);
    expect(steer(settings.hooks.PreCompact)).toHaveLength(1);
    expect(steer(settings.hooks.PreCompact)[0].hooks).toHaveLength(1);
  });
});
