import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { doorInstallStep, doorSignInStep, type DoorStepEnv, type ResumeWords } from '../../src/install/doorSteps.js';

const words: ResumeWords = { resume: 'open your setup page again', elsewhere: 'open your setup page on a computer with a browser' };

function env(overrides: Partial<DoorStepEnv> = {}): DoorStepEnv {
  return {
    logFile: '/tmp/x.log', interactive: false, browser: true,
    proveSignedIn: async () => 'signed-out', doorPath: () => '/bin/door',
    runLogged: () => 1, sudoReady: () => false, runAttached: () => 0, startDetached: () => 42,
    processStamp: () => 'stamp', stopProcess: () => undefined, print: () => undefined, sleep: async () => undefined,
    ...overrides,
  };
}

describe('door steps run without the CLI', () => {
  it('reaches nothing that needs a terminal or the install command', () => {
    const source = fs.readFileSync('src/install/doorSteps.ts', 'utf-8');
    expect(source).not.toMatch(/from '[^']*commands\/install(\.js|\/)/);
    expect(source).not.toMatch(/readline|process\.stdin|instar install/);
  });

  it('speaks in the words of whatever runs it', async () => {
    const started = await doorSignInStep(env(), 'claude-code', { words });
    expect(started).toMatchObject({ kind: 'awaiting-person', loginPid: 42, loginStamp: 'stamp' });
    expect((started as { instruction: string }).instruction).toContain('then open your setup page again.');

    const noBrowser = await doorSignInStep(env({ browser: false }), 'claude-code', { words });
    expect((noBrowser as { instruction: string }).instruction).toContain('so open your setup page on a computer with a browser.');

    const missing = await doorSignInStep(env({ doorPath: () => null }), 'claude-code', { words });
    expect(missing).toMatchObject({ kind: 'failed', nextStep: 'Open your setup page again.' });
  });

  it('waits on a sign-in still running rather than opening a second one', async () => {
    const startDetached = vi.fn(() => 7);
    const result = await doorSignInStep(env({ startDetached }), 'claude-code', { words, awaiting: { loginPid: 42, loginStamp: 'stamp' } });
    expect(startDetached).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'awaiting-person', loginPid: 42 });
  });

  it('never installs a door already there', () => {
    const runLogged = vi.fn(() => 0);
    expect(doorInstallStep(env({ runLogged }), 'claude-code', words)).toEqual({ kind: 'done' });
    expect(runLogged).not.toHaveBeenCalled();
  });

  it('a failed door install names what to do next', () => {
    const result = doorInstallStep(env({ doorPath: () => null }), 'claude-code', words);
    expect(result).toMatchObject({ kind: 'failed' });
    expect((result as { nextStep: string }).nextStep).toContain('Then open your setup page again.');
  });

  it('a held Claude token needs no sign-in, and an obtained one says so', async () => {
    expect(await doorSignInStep(env(), 'claude-code', { words, claudeTokenHeld: true })).toEqual({ kind: 'done' });
    expect(await doorSignInStep(env(), 'claude-code', { words, obtainClaudeToken: async () => true })).toMatchObject({ kind: 'done', note: 'Claude will use the token you pasted.' });
  });
});
