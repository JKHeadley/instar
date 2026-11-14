/**
 * E2E "feature is alive": real processes, the built dist, the same handlers
 * server.ts installs. A closed pipe must leave the process running; an unknown
 * error must still crash it, with its stack in the FATAL line.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const POLICY_PATH = path.resolve(__dirname, '../../dist/core/uncaughtExceptionPolicy.js');
const GUARD_PATH = path.resolve(__dirname, '../../dist/core/pipeErrorGuard.js');
const DIST_BUILT = existsSync(POLICY_PATH) && existsSync(GUARD_PATH);

const CHILD_SCRIPT = `
import { spawn } from 'node:child_process';
const { handleProcessLevelError } = await import(process.env.POLICY_PATH);
const { guardProcessStdio } = await import(process.env.GUARD_PATH);
const onFatalCleanup = () => {};
process.on('uncaughtException', (e) => handleProcessLevelError(e, 'uncaughtException', { onFatalCleanup }));
process.on('unhandledRejection', (r) => handleProcessLevelError(r, 'unhandledRejection', { onFatalCleanup }));
const scenario = process.env.SCENARIO;
if (scenario === 'unguarded-child-stdin') {
  // No guard on purpose: this is the policy backstop for a writer nobody guarded.
  const script = "require('fs').closeSync(0); console.log('closed'); setTimeout(() => {}, 1000)";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdout.once('data', () => child.stdin.write(Buffer.alloc(1024 * 1024)));
} else if (scenario === 'stderr-reader-gone') {
  // Stands in for the server.log tee: stderr is about to die, so reports go to stdout.
  console.warn = (...args) => process.stdout.write(args.join(' ') + '\\n');
  guardProcessStdio();
  process.stdin.once('data', () => { process.stderr.write('after the reader left\\n'); });
  process.stdout.write('READY\\n');
} else if (scenario === 'control-unknown') {
  setTimeout(() => { throw new Error('genuine unknown corruption'); }, 10);
}
setTimeout(() => { process.stdout.write('STILL-ALIVE\\n'); process.exit(0); }, 1500);
`;

interface ChildResult { code: number | null; stdout: string; stderr: string; }

function runChild(scenario: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: { ...process.env, POLICY_PATH, GUARD_PATH, SCENARIO: scenario },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (scenario === 'stderr-reader-gone' && stdout.includes('READY')) {
        child.stderr.destroy();
        child.stdin.write('go\n');
      }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!DIST_BUILT)('closed pipe: the server survives it and still crashes on the unknown', () => {
  it('survives an unguarded stdin write to a child that closed its stdin', async () => {
    const { code, stdout, stderr } = await runChild('unguarded-child-stdin');
    expect(stdout).toContain('STILL-ALIVE');
    expect(code).toBe(0);
    expect(stderr).toContain('write EPIPE');
    expect(stderr).toContain('first-seen stack');
  }, 30_000);

  it('survives its stderr reader going away, as when the tee behind it dies', async () => {
    const { code, stdout } = await runChild('stderr-reader-gone');
    expect(stdout).toContain('STILL-ALIVE');
    expect(code).toBe(0);
    // The guard took it, not the process policy behind it.
    expect(stdout).toContain('[pipe-guard] process stderr lost its reader');
    expect(stdout).not.toContain('Non-fatal uncaughtException');
  }, 30_000);

  it('still exits 1 on an unknown error, with the stack in the FATAL line', async () => {
    const { code, stdout, stderr } = await runChild('control-unknown');
    expect(stdout).not.toContain('STILL-ALIVE');
    expect(code).toBe(1);
    expect(stderr).toContain('[FATAL] Uncaught uncaughtException');
    expect(stderr).toMatch(/genuine unknown corruption\n\s*Error: genuine unknown corruption\n\s+at /);
  }, 30_000);
});
