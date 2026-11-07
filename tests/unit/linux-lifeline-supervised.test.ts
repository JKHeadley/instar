/**
 * Linux lifeline is marked supervised (docs/specs/linux-lifeline-supervised.md).
 *
 * THE DEFECT (2026-11-06, two-server takeover drill, Ubuntu). The systemd unit starts the bash
 * boot wrapper, so the lifeline's parent is bash and detectLaunchdSupervised() said nobody would
 * respawn it. Every self-restart was skipped ("would restart ... but unsupervised") while the
 * agent stayed silent. The macOS plist sets INSTAR_SUPERVISED=1 for this case; the unit did not.
 * Turning it on exposed a second gap: the watchdog cooldown bounded how often, never how many.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addSystemdSupervisedEnv, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { buildLinuxSystemdUnit, SYSTEMD_SUPERVISED_ENV_LINE } from '../../src/commands/setup.js';
import { detectLaunchdSupervised } from '../../src/lifeline/detectLaunchdSupervised.js';
import { decide, readRateLimitState, writeRateLimitState, markLatestRestartExited, statePath, WATCHDOG_DAILY_CAP, WATCHDOG_COOLDOWN_MS, type RateLimitState } from '../../src/lifeline/rateLimitState.js';
import { RestartOrchestrator } from '../../src/lifeline/RestartOrchestrator.js';
import { TelegramLifeline } from '../../src/lifeline/TelegramLifeline.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UNIT = `[Unit]
Description=Instar Agent - echo
After=network.target

[Service]
Type=simple
KillMode=process
ExecStart=/bin/bash /home/echo/agent/.instar/instar-boot.sh lifeline start --dir /home/echo/agent
WorkingDirectory=/home/echo/agent
Restart=always
RestartSec=10
Environment=PATH=/usr/bin:/bin

[Install]
WantedBy=default.target
`;

describe('the unit says the lifeline is supervised', () => {
  it('new units carry the line inside [Service]', () => {
    const unit = buildLinuxSystemdUnit({ projectName: 'a', projectDir: '/d', hasTelegram: true, bootWrapper: '/d/.instar/instar-boot.sh', envPath: '/usr/bin' });
    const service = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'));
    expect(SYSTEMD_SUPERVISED_ENV_LINE).toBe('Environment=INSTAR_SUPERVISED=1');
    expect(service).toContain(SYSTEMD_SUPERVISED_ENV_LINE);
  });

  it('adds it to an existing unit right after [Service], rest unchanged', () => {
    expect(addSystemdSupervisedEnv(UNIT)).toBe(UNIT.replace('[Service]\n', `[Service]\n${SYSTEMD_SUPERVISED_ENV_LINE}\n`));
  });

  it('is idempotent', () => {
    const once = addSystemdSupervisedEnv(UNIT);
    expect(addSystemdSupervisedEnv(once)).toBe(once);
  });

  it('keeps CRLF files CRLF', () => {
    const crlf = UNIT.replace(/\n/g, '\r\n');
    const next = addSystemdSupervisedEnv(crlf);
    expect(next).toContain(`[Service]\r\n${SYSTEMD_SUPERVISED_ENV_LINE}\r\n`);
    expect(next.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps an operator value, plain, quoted or among several assignments', () => {
    for (const line of ['Environment=INSTAR_SUPERVISED=0', 'Environment="INSTAR_SUPERVISED=0"', 'Environment="A=1" "INSTAR_SUPERVISED=0"']) {
      const custom = UNIT.replace('Type=simple\n', `Type=simple\n${line}\n`);
      expect(addSystemdSupervisedEnv(custom)).toBe(custom);
    }
  });

  it('leaves a file with no [Service] section alone', () => {
    const notOurs = '[Unit]\nDescription=x\n';
    expect(addSystemdSupervisedEnv(notOurs)).toBe(notOurs);
  });
});

describe('detection, in the exact drill shape (parent is the bash wrapper)', () => {
  const base = { platform: 'linux' as NodeJS.Platform, ppid: 4242, parentNameLookup: () => 'bash' };
  it('supervised with the variable', () => {
    expect(detectLaunchdSupervised({ ...base, env: { INSTAR_SUPERVISED: '1' } })).toBe(true);
  });
  it('not supervised without it, or with 0 (the drop-in opt-out)', () => {
    expect(detectLaunchdSupervised({ ...base, env: {} })).toBe(false);
    expect(detectLaunchdSupervised({ ...base, env: { INSTAR_SUPERVISED: '0' } })).toBe(false);
  });
});

describe('the migration on existing Linux installs', () => {
  const realPlatform = process.platform;
  const realHome = process.env.HOME;
  let home: string;
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
  const unitPath = () => path.join(home, '.config', 'systemd', 'user', 'instar-echo.service');
  const run = () => {
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const m = new PostUpdateMigrator({ projectName: 'echo', projectDir: home, stateDir: path.join(home, '.instar'), port: 4042 } as never);
    (m as unknown as { migrateSystemdSupervised: (r: typeof result) => void }).migrateSystemdSupervised(result);
    return result;
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-supervised-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    setPlatform(realPlatform);
    process.env.HOME = realHome;
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/linux-lifeline-supervised.test.ts' });
  });

  it('patches the unit and keeps a backup; a second run changes nothing', () => {
    setPlatform('linux');
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), UNIT);
    const first = run();
    expect(first.errors).toEqual([]);
    expect(first.upgraded.join(' ')).toContain('INSTAR_SUPERVISED=1 on disk'); // daemon-reload is skipped under a test runner
    expect(fs.readFileSync(unitPath(), 'utf-8')).toBe(addSystemdSupervisedEnv(UNIT));
    const backups = fs.readdirSync(path.dirname(unitPath())).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(unitPath()), backups[0]), 'utf-8')).toBe(UNIT);
    const second = run();
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.join(' ')).toContain('already declared');
  });

  it('skips on non-linux and when there is no unit', () => {
    setPlatform('darwin');
    expect(run().skipped.join(' ')).toContain('non-linux');
    setPlatform('linux');
    expect(run().skipped.join(' ')).toContain('no systemd unit present');
  });

  it('runs in the migration pass right after the KillMode migration', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/PostUpdateMigrator.ts'), 'utf-8');
    expect(src).toContain('this.migrateSystemdKillMode(result);\n    this.migrateSystemdSupervised(result);');
  });
});

describe('the watchdog restart brake has a total, and its alarm can fire', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_800_000_000_000;
  const state = (ats: number[], bucket: 'watchdog' | 'plannedUpgrade' = 'watchdog'): RateLimitState => ({
    lastRestartAt: new Date(Math.max(...ats)).toISOString(),
    lastReason: 'x',
    history: ats.map((t) => ({ at: new Date(t).toISOString(), reason: 'x', bucket, exited: true })),
  });
  const ok = (s: RateLimitState) => ({ kind: 'ok' as const, state: s });

  it('refuses the 7th watchdog restart in 24h, and an entry older than 24h no longer counts', () => {
    const six = Array.from({ length: WATCHDOG_DAILY_CAP }, (_, i) => now - 23 * HOUR + i * HOUR);
    expect(decide(ok(state(six)), 'watchdog', now)).toEqual({ allowed: false, reason: 'watchdog-daily-cap' });
    const agedOut = [now - 25 * HOUR, ...six.slice(1)];
    expect(decide(ok(state(agedOut)), 'watchdog', now).allowed).toBe(true);
  });

  it('the 6th restart inside an hour at 10-minute spacing is a storm; the 5th is not', () => {
    const spaced = (n: number) => Array.from({ length: n }, (_, i) => now - (n - i) * WATCHDOG_COOLDOWN_MS);
    expect(decide(ok(state(spaced(5))), 'watchdog', now).stormActive).toBe(true);  // deciding the 6th
    expect(decide(ok(state(spaced(4))), 'watchdog', now).stormActive).toBe(false); // deciding the 5th
  });

  it('the watchdog cap does not touch upgrade restarts', () => {
    const six = Array.from({ length: WATCHDOG_DAILY_CAP }, (_, i) => now - 20 * HOUR + i * HOUR);
    expect(decide(ok(state(six)), 'plannedUpgrade', now).allowed).toBe(true);
  });

  it('attempts that never exited (unsupervised, deferred, or from an older version) do not use up the cap', () => {
    const six = state(Array.from({ length: WATCHDOG_DAILY_CAP }, (_, i) => now - 20 * HOUR + i * HOUR));
    const unexited = { ...six, history: six.history.map(({ exited: _e, ...h }) => h) };
    expect(decide(ok(unexited), 'watchdog', now).allowed).toBe(true);
    const mixed = { ...six, history: six.history.map((h, i) => (i === 0 ? { ...h, exited: false } : h)) };
    expect(decide(ok(mixed), 'watchdog', now).allowed).toBe(true); // 5 real restarts, under the cap
  });

  it('the orchestrator records an exit only when it really exits', async () => {
    const recordExit = vi.fn(); const exitFn = vi.fn();
    const reporter = { report: () => {} } as never;
    const base = { quiesce: async () => {}, persistAll: async () => {}, exitFn, recordExit, reporter, persistBudgetMs: 10, hardKillMs: 1000 };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await new RestartOrchestrator({ ...base, isSupervised: false }).requestRestart({ reason: 'r', bucket: 'watchdog' })).toBe('suppressed');
    expect(await new RestartOrchestrator({ ...base, isSupervised: true, isShadowInstallUpdating: () => true }).requestRestart({ reason: 'r', bucket: 'watchdog' })).toBe('suppressed');
    warn.mockRestore();
    expect(recordExit).not.toHaveBeenCalled();
    expect(exitFn).not.toHaveBeenCalled();
    expect(await new RestartOrchestrator({ ...base, isSupervised: true }).requestRestart({ reason: 'r', bucket: 'watchdog' })).toBe('proceeded');
    expect(recordExit).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
    expect(recordExit.mock.invocationCallOrder[0]).toBeLessThan(exitFn.mock.invocationCallOrder[0]);
  });

  it('marking the latest entry exited keeps the file valid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-exited-'));
    try {
      writeRateLimitState(dir, 'noForwardStuck', 'watchdog', null);
      markLatestRestartExited(dir);
      const r = readRateLimitState(dir);
      expect(r.kind).toBe('ok');
      expect((r as { state: RateLimitState }).state.history.at(-1)?.exited).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/linux-lifeline-supervised.test.ts:mark' });
    }
  });

  it('reports once when self-restart has given up, however many ticks follow', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exhausted-'));
    try {
      let prior: RateLimitState | null = null;
      for (let i = 0; i < WATCHDOG_DAILY_CAP; i++) {
        writeRateLimitState(dir, 'noForwardStuck', 'watchdog', prior, Date.now() - (WATCHDOG_DAILY_CAP - i) * HOUR);
        markLatestRestartExited(dir);
        prior = (readRateLimitState(dir) as { state: RateLimitState }).state;
      }
      expect(readRateLimitState(dir).kind).toBe('ok');
      expect(fs.existsSync(statePath(dir))).toBe(true);
      const report = vi.fn();
      vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report } as never);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const l = Object.create(TelegramLifeline.prototype) as { projectConfig: unknown; selfRestartExhaustedReported: boolean; orchestrator: null };
      Object.assign(l, { projectConfig: { stateDir: dir }, selfRestartExhaustedReported: false, orchestrator: null });
      const initiate = (TelegramLifeline.prototype as unknown as { initiateRestart: (b: string, r: string) => void }).initiateRestart;
      for (let i = 0; i < 5; i++) initiate.call(l, 'watchdog', 'conflict409Stuck');
      log.mockRestore();
      const exhausted = report.mock.calls.filter(([e]) => e.feature === 'TelegramLifeline.selfRestartExhausted');
      expect(exhausted).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/linux-lifeline-supervised.test.ts:exhausted' });
    }
  });

  it('a malformed history entry reads as a corrupt file (restarts blocked), not a skipped entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-entry-'));
    try {
      const good = { at: new Date().toISOString(), reason: 'x', bucket: 'watchdog' };
      for (const bad of [null, { ...good, at: 'not a time' }, { ...good, bucket: 'nope' }, 'x']) {
        fs.writeFileSync(statePath(dir), JSON.stringify({ lastRestartAt: good.at, lastReason: 'x', history: [good, bad] }));
        expect(readRateLimitState(dir).kind).toBe('corrupt');
      }
      fs.writeFileSync(statePath(dir), JSON.stringify({ lastRestartAt: good.at, lastReason: 'x', history: [good] }));
      expect(readRateLimitState(dir).kind).toBe('ok');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/linux-lifeline-supervised.test.ts:corrupt' });
    }
  });

  it('a corrupt history file is reported once, not only logged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-report-'));
    try {
      fs.writeFileSync(statePath(dir), JSON.stringify({ lastRestartAt: new Date().toISOString(), lastReason: 'x', history: [null] }));
      const report = vi.fn();
      vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report } as never);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const l = Object.create(TelegramLifeline.prototype) as Record<string, unknown>;
      Object.assign(l, { projectConfig: { stateDir: dir }, selfRestartExhaustedReported: false, restartStateCorruptReported: false, orchestrator: null });
      const initiate = (TelegramLifeline.prototype as unknown as { initiateRestart: (b: string, r: string) => void }).initiateRestart;
      for (let i = 0; i < 4; i++) initiate.call(l, 'plannedUpgrade', 'upgrade');
      log.mockRestore();
      expect(report.mock.calls.filter(([e]) => e.feature === 'TelegramLifeline.restartStateCorrupt')).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/linux-lifeline-supervised.test.ts:corrupt-report' });
    }
  });
});
