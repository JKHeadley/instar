/**
 * The install flow and its ledger (spec install-experience 4.1 to 4.3): resume at every step, no
 * hang with no terminal, consent stays explicit, and nothing is ever reported done on a guess.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildInstallFlow,
  impliedInstallDoor,
  INSTALL_INITIAL_STATE,
  type InstallFlowContext,
  type WizardActionKind,
} from '../../src/commands/setup-wizard/state-machine.js';
import { runInstallFlow, type InstallIo, type StepHandler, type StepResult } from '../../src/commands/install/engine.js';
import {
  installProgressPath,
  newInstallProgress,
  readInstallProgress,
  writeInstallProgress,
  type InstallProgress,
} from '../../src/commands/install/progress.js';
import { answersFileProblem, buildInstallHandlers, ensureViewingPin, finishAgentConfig, INSTALL_EXIT_CODES, installInitOptions, reportedStatus, tmuxInstallCommand, type InstallEnv, MIN_FREE_BYTES, preflightRefusal, presetFromAnswers } from '../../src/commands/install.js';

const ALL_ACTIONS: WizardActionKind[] = [
  'install-preflight', 'install-tools', 'door-install', 'door-sign-in', 'agent-init',
  'start-server', 'install-autostart', 'owner-slot',
];

function context(overrides: Partial<InstallFlowContext> = {}): InstallFlowContext {
  return {
    detectedDoors: ['claude-code'],
    validateName: (name) => (name === 'taken' ? 'That name is taken.' : null),
    describePlan: () => ['Create your agent'],
    ...overrides,
  };
}

function okHandlers(ran: string[], overrides: Partial<Record<WizardActionKind, StepHandler>> = {}): Partial<Record<WizardActionKind, StepHandler>> {
  const handlers: Partial<Record<WizardActionKind, StepHandler>> = {};
  for (const kind of ALL_ACTIONS) {
    handlers[kind] = overrides[kind] ?? (async (): Promise<StepResult> => {
      ran.push(kind);
      return { kind: 'done' };
    });
  }
  return handlers;
}

function headlessIo(printed: string[] = []): InstallIo {
  return {
    interactive: false,
    print: (text) => { printed.push(text); },
    ask: () => { throw new Error('a run with no terminal must never ask'); },
  };
}

const FULL_PRESET = { 'agent-name': 'scout', 'agent-purpose': 'keep my week organized', consent: 'yes' };

describe('install flow', () => {
  let saved: InstallProgress[];
  const save = (p: InstallProgress): void => { saved.push(JSON.parse(JSON.stringify(p)) as InstallProgress); };

  beforeEach(() => { saved = []; });

  it('runs every step in the specified order with no terminal', async () => {
    const ran: string[] = [];
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    const status = await runInstallFlow({
      states: buildInstallFlow(context()),
      progress,
      save,
      handlers: okHandlers(ran),
      io: headlessIo(),
      preset: FULL_PRESET,
    });
    expect(status).toBe('complete');
    expect(ran).toEqual(ALL_ACTIONS);
    expect(progress.answers).toMatchObject({ agentName: 'scout', door: 'claude-code', installConsent: true });
  });

  it('records why and returns, instead of hanging, when an answer is missing with no terminal', async () => {
    const ran: string[] = [];
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    const status = await runInstallFlow({
      states: buildInstallFlow(context()),
      progress,
      save,
      handlers: okHandlers(ran),
      io: headlessIo(),
      preset: { 'agent-name': 'scout', 'agent-purpose': 'x' },
    });
    expect(status).toBe('needs-answers');
    expect(progress.needs).toMatchObject({ state: 'consent', field: '--yes' });
    expect(INSTALL_EXIT_CODES[status]).not.toBe(0);
    // Nothing is installed before consent.
    expect(ran).toEqual(['install-preflight']);
  });

  it('refuses a taken name from an answers file and names the reason', async () => {
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    const status = await runInstallFlow({
      states: buildInstallFlow(context()),
      progress,
      save,
      handlers: okHandlers([]),
      io: headlessIo(),
      preset: { ...FULL_PRESET, 'agent-name': 'taken' },
    });
    expect(status).toBe('needs-answers');
    expect(progress.needs).toEqual({ state: 'agent-name', field: 'name', reason: 'That name is taken.' });
  });

  it('declining installs nothing past the checks', async () => {
    const ran: string[] = [];
    const status = await runInstallFlow({
      states: buildInstallFlow(context()),
      progress: newInstallProgress(INSTALL_INITIAL_STATE),
      save,
      handlers: okHandlers(ran),
      io: headlessIo(),
      preset: { ...FULL_PRESET, consent: 'no' },
    });
    expect(status).toBe('declined');
    expect(ran).toEqual(['install-preflight']);
  });

  it('awaiting a person exits successfully, and resume continues from that step without repeating others', async () => {
    const ran: string[] = [];
    let signedIn = false;
    const handlers = okHandlers(ran, {
      'door-sign-in': async () => {
        ran.push('door-sign-in');
        return signedIn ? { kind: 'done' } : { kind: 'awaiting-person', instruction: 'Finish in the window that opened.', loginPid: 42 };
      },
    });
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    const first = await runInstallFlow({ states: buildInstallFlow(context()), progress, save, handlers, io: headlessIo(), preset: FULL_PRESET });
    expect(first).toBe('awaiting-person');
    expect(INSTALL_EXIT_CODES[first]).toBe(0);
    expect(progress.cursor).toBe('do-door-sign-in');
    expect(progress.awaiting).toMatchObject({ state: 'do-door-sign-in', loginPid: 42 });

    signedIn = true;
    const second = await runInstallFlow({ states: buildInstallFlow(context()), progress, save, handlers, io: headlessIo() });
    expect(second).toBe('complete');
    expect(progress.awaiting).toBeUndefined();
    expect(ran.filter((r) => r === 'door-install')).toHaveLength(1);
    expect(ran.filter((r) => r === 'door-sign-in')).toHaveLength(2);
  });

  it('a failed step stays on its cursor with a plain next step, and resume retries only that step', async () => {
    const ran: string[] = [];
    let broken = true;
    const handlers = okHandlers(ran, {
      'agent-init': async () => {
        ran.push('agent-init');
        return broken ? { kind: 'failed', message: 'It broke.', nextStep: 'Do this.' } : { kind: 'done' };
      },
    });
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    expect(await runInstallFlow({ states: buildInstallFlow(context()), progress, save, handlers, io: headlessIo(), preset: FULL_PRESET })).toBe('failed');
    expect(progress.failure).toEqual({ state: 'do-init', message: 'It broke.', nextStep: 'Do this.' });
    broken = false;
    expect(await runInstallFlow({ states: buildInstallFlow(context()), progress, save, handlers, io: headlessIo() })).toBe('complete');
    expect(progress.failure).toBeUndefined();
    expect(ran.filter((r) => r === 'install-tools')).toHaveLength(1);
  });

  it('resumes from every step after a crash at that step', async () => {
    const states = buildInstallFlow(context());
    const baseRan: string[] = [];
    const base = newInstallProgress(INSTALL_INITIAL_STATE);
    const snapshots: InstallProgress[] = [];
    await runInstallFlow({
      states,
      progress: base,
      save: (p) => { snapshots.push(JSON.parse(JSON.stringify(p)) as InstallProgress); },
      handlers: okHandlers(baseRan),
      io: headlessIo(),
      preset: FULL_PRESET,
    });
    for (const snapshot of snapshots.filter((s) => s.status === 'running')) {
      const copy = JSON.parse(JSON.stringify(snapshot)) as InstallProgress;
      const status = await runInstallFlow({ states, progress: copy, save, handlers: okHandlers([]), io: headlessIo(), preset: FULL_PRESET });
      expect(status).toBe('complete');
    }
  });

  it('shows the plan even when --yes already gave consent', async () => {
    const printed: string[] = [];
    await runInstallFlow({
      states: buildInstallFlow(context()),
      progress: newInstallProgress(INSTALL_INITIAL_STATE),
      save,
      handlers: okHandlers([]),
      io: headlessIo(printed),
      preset: FULL_PRESET,
    });
    expect(printed.join('\n')).toContain('This will:');
    expect(printed.join('\n')).toContain('Create your agent');
  });

  it('records a step that throws as failed, so a poller never waits forever', async () => {
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    const status = await runInstallFlow({
      states: buildInstallFlow(context()),
      progress,
      save,
      handlers: okHandlers([], { 'agent-init': async () => { throw new Error('disk full'); } }),
      io: headlessIo(),
      preset: FULL_PRESET,
    });
    expect(status).toBe('failed');
    expect(progress.failure?.message).toContain('disk full');
    expect(progress.cursor).toBe('do-init');
  });

  it('asks about the door only when it is ambiguous', () => {
    expect(impliedInstallDoor(context({ detectedDoors: ['claude-code'] }))).toBe('claude-code');
    expect(impliedInstallDoor(context({ detectedDoors: ['claude-code', 'codex-cli'] }))).toBeUndefined();
    expect(impliedInstallDoor(context({ detectedDoors: [] }))).toBeUndefined();
    expect(impliedInstallDoor(context({ detectedDoors: ['claude-code', 'codex-cli'], runningInDoor: 'codex-cli' }))).toBe('codex-cli');
  });

  it('asks at most three questions before consent', async () => {
    const prompts: string[] = [];
    const printed: string[] = [];
    const answers = ['scout', 'help me', '2', 'yes'];
    await runInstallFlow({
      states: buildInstallFlow(context({ detectedDoors: [] })),
      progress: newInstallProgress(INSTALL_INITIAL_STATE),
      save,
      handlers: okHandlers([]),
      io: {
        interactive: true,
        print: (text) => { printed.push(text); },
        ask: async (prompt) => { prompts.push(prompt); return answers[prompts.length - 1]; },
      },
    });
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toContain('Is that okay?');
    expect(printed.join('\n')).toContain('This will:');
    expect(printed.join('\n')).toContain('This creates a new agent');
  });
});

describe('install ledger', () => {
  let home: string;

  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-ledger-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/install cleanup' }); });

  it('round-trips, and a missing file reads as no install', () => {
    const file = installProgressPath(home);
    expect(readInstallProgress(file)).toBeNull();
    const progress = newInstallProgress('do-preflight');
    writeInstallProgress(file, progress);
    expect(readInstallProgress(file)).toMatchObject({ installId: progress.installId, cursor: 'do-preflight' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('throws on a file it does not recognize rather than starting over', () => {
    const file = installProgressPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":9}');
    expect(() => readInstallProgress(file)).toThrow(/Unrecognized/);
  });
});

describe('preflight', () => {
  const ok = { platform: 'linux' as const, nodeVersion: 'v22.3.0', freeBytes: MIN_FREE_BYTES };

  it('passes on both sides of the boundaries', () => {
    expect(preflightRefusal(ok)).toBeNull();
    expect(preflightRefusal({ ...ok, nodeVersion: 'v20.12.0' })).toBeNull();
    expect(preflightRefusal({ ...ok, freeBytes: null })).toBeNull();
    expect(preflightRefusal({ ...ok, nodeVersion: 'v20.11.9' })?.message).toContain('20.12');
    expect(preflightRefusal({ ...ok, freeBytes: MIN_FREE_BYTES - 1 })?.message).toContain('free disk space');
    expect(preflightRefusal({ ...ok, platform: 'win32' })?.message).toContain('WSL');
  });
});

describe('answers file', () => {
  it('only --yes supplies consent', () => {
    expect(presetFromAnswers({ name: 'a', purpose: 'b', autostart: true }, false)).toEqual({ 'agent-name': 'a', 'agent-purpose': 'b' });
    expect(presetFromAnswers({}, true)).toEqual({ consent: 'yes' });
  });
});

describe('install status', () => {
  it('shows a dead run as interrupted, and leaves other states alone', () => {
    const progress = newInstallProgress(INSTALL_INITIAL_STATE);
    expect(reportedStatus(progress, null)).toBe('interrupted');
    expect(reportedStatus(progress, 123)).toBe('running');
    progress.status = 'awaiting-person';
    expect(reportedStatus(progress, null)).toBe('awaiting-person');
  });
});

describe('answers file problems', () => {
  it('refuses an autostart that would be misread', () => {
    expect(answersFileProblem({ autostart: 'no' as unknown as boolean })).toContain('true or false');
    expect(answersFileProblem({ autostart: false, name: 'a' })).toBeNull();
    expect(answersFileProblem({ name: 3 as unknown as string })).toContain('name');
  });
});

describe('tmux install command', () => {
  const having = (...commands: string[]) => (command: string) => commands.includes(command);

  it('uses what the computer has, and sends the person away otherwise', () => {
    expect(tmuxInstallCommand('darwin', having('brew'))).toEqual(['brew', 'install', 'tmux']);
    expect(tmuxInstallCommand('darwin', having())).toBeNull();
    expect(tmuxInstallCommand('linux', having('sudo', 'apt-get'))).toEqual(['sudo', 'apt-get', 'install', '-y', 'tmux']);
    expect(tmuxInstallCommand('linux', having('sudo', 'dnf'))).toEqual(['sudo', 'dnf', 'install', '-y', 'tmux']);
    expect(tmuxInstallCommand('linux', having('apt-get'))).toBeNull();
  });
});

describe('door sign-in step', () => {
  const home = os.homedir();
  const stub = (overrides: Partial<InstallEnv>): InstallEnv => ({
    logFile: path.join(home, 'install.log'),
    interactive: false,
    browser: true,
    proveSignedIn: async () => 'signed-out',
    doorPath: () => '/bin/door',
    runAttached: () => 0,
    startDetached: () => 111,
    processStamp: () => 'stamp-a',
    stopProcess: () => {},
    print: () => {},
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  } as InstallEnv);
  const run = async (env: InstallEnv, awaiting?: InstallProgress['awaiting']) => {
    const progress = newInstallProgress('do-door-sign-in');
    if (awaiting) progress.awaiting = awaiting;
    return buildInstallHandlers(env)['door-sign-in']!({ door: 'claude-code' }, progress);
  };

  it('never signs in over a login it can see or can\'t judge', async () => {
    const started: string[] = [];
    const startDetached = () => { started.push('x'); return 111; };
    expect(await run(stub({ proveSignedIn: async () => 'signed-in', startDetached }))).toEqual({ kind: 'done' });
    expect((await run(stub({ proveSignedIn: async () => 'unknown', startDetached }))).kind).toBe('done');
    expect(started).toEqual([]);
  });

  it('with no browser, sends the person to their terminal and starts nothing', async () => {
    const result = await run(stub({ browser: false, startDetached: () => { throw new Error('must not start'); } }));
    expect(result).toMatchObject({ kind: 'awaiting-person' });
    expect((result as { instruction: string }).instruction).toContain('your own terminal');
  });

  it('starts one sign-in and keeps the same one across resumes', async () => {
    let starts = 0;
    const env = stub({ startDetached: () => { starts++; return 111; } });
    const first = await run(env);
    expect(first).toMatchObject({ kind: 'awaiting-person', loginPid: 111, loginStamp: 'stamp-a' });
    const second = await run(env, { state: 'do-door-sign-in', instruction: '', loginPid: 111, loginStamp: 'stamp-a' });
    expect(second).toMatchObject({ kind: 'awaiting-person', loginPid: 111 });
    expect(starts).toBe(1);
  });

  it('does not mistake a reused pid for the sign-in', async () => {
    let starts = 0;
    const env = stub({ startDetached: () => { starts++; return 222; }, processStamp: (pid) => (pid === 222 ? 'new' : 'someone-else') });
    const result = await run(env, { state: 'do-door-sign-in', instruction: '', loginPid: 111, loginStamp: 'stamp-a' });
    expect(starts).toBe(1);
    expect(result).toMatchObject({ loginPid: 222, loginStamp: 'new' });
  });

  it('does not claim a window opened when the sign-in died at once', async () => {
    const result = await run(stub({ processStamp: () => null }));
    expect((result as { instruction: string }).instruction).toContain("couldn't open a window");
    expect(result).not.toHaveProperty('loginPid');
  });

  it('stops a waiting background sign-in before an interactive one', async () => {
    const stopped: number[] = [];
    let proven = false;
    const env = stub({
      interactive: true,
      stopProcess: (pid) => { stopped.push(pid); },
      runAttached: () => { proven = true; return 0; },
      proveSignedIn: async () => (proven ? 'signed-in' : 'signed-out'),
    });
    expect(await run(env, { state: 'do-door-sign-in', instruction: '', loginPid: 111, loginStamp: 'stamp-a' })).toEqual({ kind: 'done' });
    expect(stopped).toEqual([111]);
  });
});

describe('finishing the agent config', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-config-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/install cleanup' }); });

  it('turns off the public tunnel that init defaults to, and sets a PIN', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ tunnel: { enabled: true, type: 'quick' } }));
    finishAgentConfig(file);
    const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(config.tunnel).toEqual({ enabled: false, type: 'quick' });
    expect(config.dashboardPin).toMatch(/^\d{6}$/);
  });
});

describe('creating the agent', () => {
  it('never lets the agent install its own start-on-login job, whatever the person answered', () => {
    for (const autostartConsent of [true, false, undefined]) {
      const options = installInitOptions({ agentName: 'a', door: 'codex-cli', autostartConsent });
      expect(options).not.toHaveProperty('autostart');
      expect(options.interactive).toBe(false);
      expect(options.skipCloudBackup).toBe(true);
    }
  });
});

describe('viewing PIN', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-pin-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/install cleanup' }); });

  it('mints a six-digit PIN once and keeps an existing one', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"port":4040}');
    const pin = ensureViewingPin(file);
    expect(pin).toMatch(/^\d{6}$/);
    expect(ensureViewingPin(file)).toBe(pin);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ port: 4040, dashboardPin: pin });
  });
});
