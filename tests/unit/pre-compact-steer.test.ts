/**
 * context-budget-layered-summaries §9.1/§9.5 — PreCompact steering.
 *
 * Claude Code 2.1.321 merges a successful PreCompact hook's stdout into the
 * compaction prompt as newCustomInstructions (cut at 10,000 chars); exit 2
 * would BLOCK the compaction. So the installed hook must:
 *   - print exactly the staged, hash-verified keep-instructions for its own
 *     Instar session, and nothing in every other case;
 *   - always exit 0;
 *   - never compose text (it only prints what writeKeepInstructions staged).
 * The writer refuses what the hook would refuse, so the two cannot disagree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  writeKeepInstructions,
  removeKeepInstructions,
  readKeepInstructionsPointer,
  keepInstructionsDir,
  KEEP_INSTRUCTIONS_MAX_CHARS,
} from '../../src/monitoring/keepInstructions.js';

const OP = 'tests/unit/pre-compact-steer.test.ts';
const IID = 'inst-steer-1';
const TEXT = 'Keep: the topic purpose (context budget Phase 0), the open ledger rows, the slice in flight.';

let home: string;
let stateDir: string;
let hookPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-compact-steer-'));
  stateDir = path.join(home, '.instar');
  fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0 }));
  const migrator = new PostUpdateMigrator({ projectDir: home, stateDir, port: 0, hasTelegram: false, projectName: 't' });
  hookPath = path.join(stateDir, 'hooks', 'instar', 'pre-compact-steer.sh');
  fs.writeFileSync(hookPath, migrator.getHookContent('pre-compact-steer'), { mode: 0o755 });
});
afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: OP }));

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'c1a2-claude', trigger: 'auto', custom_instructions: '', ...over });

const run = (input: string, env: Record<string, string> = {}) => new Promise<{ out: string; code: number | null }>((resolve) => {
  const child = spawn('bash', [hookPath], {
    env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_PROJECT_DIR: home, INSTAR_SESSION_ID: IID, ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ out, code }));
  child.stdin.on('error', () => {}); // a no-op hook exits without reading stdin
  child.stdin.end(input);
});

describe('writeKeepInstructions', () => {
  it('stages text and pointer 0600 under a 0700 dir, with the hash and size', () => {
    const r = writeKeepInstructions(stateDir, { instarSessionId: IID, text: `  ${TEXT}\n`, source: 'standing-packet' }, 5);
    expect(r.written).toBe(true);
    const dir = keepInstructionsDir(stateDir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, `${IID}.md`)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, `${IID}.json`)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, `${IID}.md`), 'utf-8')).toBe(TEXT);
    expect(readKeepInstructionsPointer(stateDir, IID)).toMatchObject({ chars: TEXT.length, source: 'standing-packet', writtenAt: 5, textPath: `_keep/${IID}.md` });
  });

  it('refuses unsafe ids, unsafe sources, empty text and text over the limit', () => {
    expect(writeKeepInstructions(stateDir, { instarSessionId: '../x', text: TEXT, source: 's' })).toEqual({ written: false, reason: 'unsafe-id' });
    expect(writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 'a b' })).toEqual({ written: false, reason: 'unsafe-source' });
    expect(writeKeepInstructions(stateDir, { instarSessionId: IID, text: '  \n', source: 's' })).toEqual({ written: false, reason: 'empty' });
    expect(writeKeepInstructions(stateDir, { instarSessionId: IID, text: 'x'.repeat(KEEP_INSTRUCTIONS_MAX_CHARS + 1), source: 's' })).toEqual({ written: false, reason: 'too-long' });
    expect(fs.existsSync(keepInstructionsDir(stateDir))).toBe(false);
  });

  it('remove makes the pointer and text disappear', () => {
    writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 's' });
    removeKeepInstructions(stateDir, IID);
    expect(readKeepInstructionsPointer(stateDir, IID)).toBeNull();
    expect(fs.existsSync(path.join(keepInstructionsDir(stateDir), `${IID}.md`))).toBe(false);
  });
});

describe('pre-compact-steer.sh (installed hook)', () => {
  it('prints the staged text exactly, and keeps printing it on later compactions (standing)', async () => {
    writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 'standing-packet' });
    const a = await run(payload());
    expect(a).toEqual({ out: TEXT, code: 0 });
    const b = await run(payload({ trigger: 'manual' }));
    expect(b).toEqual({ out: TEXT, code: 0 });
  });

  it('prints nothing and exits 0 when there is nothing staged', async () => {
    expect(await run(payload())).toEqual({ out: '', code: 0 });
  });

  it('prints nothing when the text no longer matches its hash', async () => {
    writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 's' });
    fs.writeFileSync(path.join(keepInstructionsDir(stateDir), `${IID}.md`), `${TEXT} plus an injected line`);
    expect(await run(payload())).toEqual({ out: '', code: 0 });
  });

  it("prints nothing for another session's pointer or a pointer naming a path outside the layer root", async () => {
    writeKeepInstructions(stateDir, { instarSessionId: 'inst-other', text: TEXT, source: 's' });
    expect(await run(payload())).toEqual({ out: '', code: 0 });
    // Forge a pointer for IID that points outside the root at a file whose hash it carries.
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, TEXT);
    const crypto = await import('node:crypto');
    fs.writeFileSync(path.join(keepInstructionsDir(stateDir), `${IID}.json`), JSON.stringify({
      schema: 'keep-instructions/1', instarSessionId: IID, textPath: '../../../outside.md',
      sha256: crypto.createHash('sha256').update(TEXT).digest('hex'), chars: TEXT.length, source: 's', writtenAt: 1,
    }));
    expect(await run(payload())).toEqual({ out: '', code: 0 });
  });

  it('prints nothing when the staged text is a symlink to a file outside the layer root', async () => {
    writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 's' });
    const textFile = path.join(keepInstructionsDir(stateDir), `${IID}.md`);
    const outside = path.join(home, 'outside-same.md');
    fs.writeFileSync(outside, TEXT); // same bytes, so only the confinement check can refuse it
    SafeFsExecutor.safeRmSync(textFile, { force: true, operation: OP });
    fs.symlinkSync(outside, textFile);
    expect(await run(payload())).toEqual({ out: '', code: 0 });
  });

  it('is silent on another hook event, another engine, without a session id, or with the switch off', async () => {
    writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 's' });
    expect(await run(payload({ hook_event_name: 'PostCompact' }))).toEqual({ out: '', code: 0 });
    expect(await run('not json')).toEqual({ out: '', code: 0 });
    expect(await run(payload(), { INSTAR_FRAMEWORK: 'codex-cli' })).toEqual({ out: '', code: 0 });
    expect(await run(payload(), { INSTAR_SESSION_ID: '' })).toEqual({ out: '', code: 0 });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, contextBudget: { compactionRecovery: { enabled: false } } }));
    expect(await run(payload())).toEqual({ out: '', code: 0 });
  });

  it('reads the agent home state for a worktree session (INSTAR_AGENT_HOME)', async () => {
    writeKeepInstructions(stateDir, { instarSessionId: IID, text: TEXT, source: 's' });
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(path.join(worktree, '.instar'), { recursive: true });
    expect(await run(payload(), { CLAUDE_PROJECT_DIR: worktree, INSTAR_AGENT_HOME: home })).toEqual({ out: TEXT, code: 0 });
  });

  it('the hook script has no exit path other than 0 (exit 2 would block a compaction)', () => {
    const body = fs.readFileSync(hookPath, 'utf-8');
    expect(body).not.toMatch(/exit\s+[1-9]/);
    expect(body).not.toMatch(/sys\.exit\([1-9]/);
  });
});
