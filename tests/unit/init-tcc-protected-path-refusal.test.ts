// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup only.

/**
 * Tier-1 — `instar init` refuses a TCC-protected project directory on macOS
 * BEFORE writing anything (Avoid TCC-Protected Directories, the worktree
 * convention's refusal shape). The refusal must actually refuse, and a
 * non-macOS platform must be unaffected.
 *
 * `initProject` is exercised directly with `process.exit` stubbed to throw and
 * `process.platform` / `os.homedir` overridden, so the test is deterministic
 * on every CI platform.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { initProject, refuseIfTccProtected } from '../../src/commands/init.js';

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
}

let home: string;
const realPlatform = process.platform;
let logs: string[];

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-tcc-home-'));
  fs.mkdirSync(path.join(home, 'Documents', 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code); }) as never);
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/init-tcc-protected-path-refusal.test.ts' });
});

describe('refuseIfTccProtected (the shared init gate)', () => {
  it('macOS + ~/Documents → prints the refusal and exits 1', () => {
    setPlatform('darwin');
    const target = path.join(home, 'Documents', 'Projects', 'new-agent');
    expect(() => refuseIfTccProtected(target, 'the new project directory')).toThrow(ExitSignal);
    const out = logs.join('\n');
    expect(out).toContain('Refused');
    expect(out).toContain('~/Documents');
    expect(out).toContain('docs/runbooks/move-agent-out-of-documents.md');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('macOS + a safe location → no exit, no output', () => {
    setPlatform('darwin');
    expect(() => refuseIfTccProtected(path.join(home, 'Projects', 'new-agent'), 'the new project directory')).not.toThrow();
    expect(logs).toEqual([]);
  });

  it('Linux + ~/Documents → unaffected (no exit)', () => {
    setPlatform('linux');
    expect(() => refuseIfTccProtected(path.join(home, 'Documents', 'Projects', 'new-agent'), 'the new project directory')).not.toThrow();
    expect(logs).toEqual([]);
  });
});

describe('initProject wiring — the refusal runs before any write', () => {
  it('existing-project mode (--dir under ~/Documents) on macOS refuses and writes nothing', async () => {
    setPlatform('darwin');
    const dir = path.join(home, 'Documents', 'Projects', 'monroe-workspace');
    fs.mkdirSync(dir, { recursive: true });
    await expect(initProject({ dir, skipPrereqs: true } as never)).rejects.toBeInstanceOf(ExitSignal);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(false);
    expect(logs.join('\n')).toContain('Refused');
  });

  it('fresh-project mode (`instar init <name>` with cwd under ~/Desktop) on macOS refuses before creating the directory', async () => {
    setPlatform('darwin');
    const cwd = path.join(home, 'Desktop');
    fs.mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    await expect(initProject({ name: 'fresh-agent', skipPrereqs: true } as never)).rejects.toBeInstanceOf(ExitSignal);
    expect(fs.existsSync(path.join(cwd, 'fresh-agent'))).toBe(false);
    expect(logs.join('\n')).toContain('~/Desktop');
  });

  it('standalone mode (~/.instar/agents/<name> is NOT protected) passes the gate', async () => {
    // The gate is the first thing after the path is computed; a safe path must
    // fall through to the rest of init. We prove "passed the gate" by the
    // absence of the refusal text and by init reaching its own next check
    // (the `already exists` refusal for a pre-seeded config), which is a
    // DIFFERENT exit path than ours.
    setPlatform('darwin');
    const agentDir = path.join(home, '.instar', 'agents', 'safe-agent', '.instar');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'config.json'), '{}');
    await expect(initProject({ standalone: true, name: 'safe-agent', skipPrereqs: true } as never)).rejects.toBeInstanceOf(ExitSignal);
    const out = logs.join('\n');
    expect(out).not.toContain('Refused');
    expect(out).toContain('already exists');
  });
});
