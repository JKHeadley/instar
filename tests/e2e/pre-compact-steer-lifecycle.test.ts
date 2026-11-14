/**
 * context-budget-layered-summaries §9.1/§9.5 — e2e lifecycle: an existing
 * agent's update path (migrateHooks + migrateSettings) installs
 * pre-compact-steer.sh and its PreCompact entry; keep-instructions staged by the
 * production writer are printed by the INSTALLED hook, run exactly as the
 * settings entry runs it, with the stdin shape Claude Code 2.1.321 sends. The
 * feature is alive end to end: writer → settings command → hook stdout (which
 * Claude Code merges into the compaction prompt).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { writeKeepInstructions } from '../../src/monitoring/keepInstructions.js';

const IID = 'inst-e2e-steer';

describe('PreCompact steering lifecycle — update path to hook output', () => {
  let home: string;
  let stateDir: string;
  let command: string;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-e2e-'));
    stateDir = path.join(home, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const m = new PostUpdateMigrator({ projectDir: home, stateDir, port: 0, hasTelegram: true, projectName: 'e2e' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateHooks(r: typeof result): void }).migrateHooks(result);
    (m as unknown as { migrateSettings(r: typeof result): void }).migrateSettings(result);
    expect(result.errors.filter(e => e.includes('pre-compact-steer'))).toEqual([]);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'));
    const entry = (settings.hooks.PreCompact as Array<{ hooks: Array<{ command: string }> }>)
      .find(e => e.hooks.some(h => h.command.includes('pre-compact-steer.sh')));
    command = entry!.hooks[0].command;
  });

  afterAll(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/e2e/pre-compact-steer-lifecycle.test.ts' }));

  const runInstalled = (stdin: string) => new Promise<{ out: string; code: number | null }>((resolve) => {
    const child = spawn('bash', ['-c', command], { env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_PROJECT_DIR: home, INSTAR_SESSION_ID: IID } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });

  it('the update path installs an executable hook and one PreCompact entry', () => {
    const hook = path.join(stateDir, 'hooks', 'instar', 'pre-compact-steer.sh');
    expect(fs.statSync(hook).mode & 0o100).toBe(0o100);
    expect(command).toContain('pre-compact-steer.sh');
  });

  it('the installed hook prints what the writer staged, and nothing before it is staged', async () => {
    const stdin = JSON.stringify({ session_id: 'c-e2e', transcript_path: '/x.jsonl', cwd: home, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
    expect(await runInstalled(stdin)).toEqual({ out: '', code: 0 });
    const text = 'Keep the Anchor, the open ledger rows and the work in flight.';
    expect(writeKeepInstructions(stateDir, { instarSessionId: IID, text, source: 'standing-packet' }).written).toBe(true);
    expect(await runInstalled(stdin)).toEqual({ out: text, code: 0 });
  });
});
