/**
 * The load-bearing guarantee of Increment 1: this build cannot restart a machine or
 * stop any work. A test of behaviour cannot prove an absence, so this reads the
 * source. It also walks the yield contract against the real spawn chokepoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_YIELD_REGISTRY } from '../../src/monitoring/machineMaintenance/WorkYieldRegistry.js';

const dir = path.resolve('src/monitoring/machineMaintenance');
const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
const code = (f: string) => fs.readFileSync(path.join(dir, f), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('machine maintenance cannot act', () => {
  it('holds no restart command', () => {
    for (const f of files) expect(code(f), f).not.toMatch(/\b(shutdown|reboot|sudo|systemctl|osascript|launchctl)\b/);
  });

  it('holds no way to signal or end a process', () => {
    for (const f of files) expect(code(f), f).not.toMatch(/process\.kill|\.kill\(|killSession|send-keys|sendKeys|sendInput|\bspawn\(|(?<![.\w])exec\(|execSync|spawnSync/);
  });

  it('imports only from an allowlist, so a new reach into the system fails here', () => {
    const allowed = new Set(['node:fs', 'node:os', 'node:path', 'node:crypto', '../../core/hostSemaphoreCore.js', '../../core/SafeFsExecutor.js', '../../core/pollIntent.js']);
    for (const f of files) {
      const source = code(f);
      for (const m of source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('./') || allowed.has(spec) || (f === 'readings.ts' && spec === 'node:child_process')) continue;
        throw new Error(`${f} imports ${spec}`);
      }
      expect(source, f).not.toMatch(/\bfetch\(|\brequire\(/);
    }
  });

  it('runs commands only through the one named table, with exact arguments', () => {
    const users = files.filter((f) => /execFile\b/.test(code(f)));
    expect(users).toEqual(['readings.ts']);
    expect(code('readings.ts').match(/execFile\(/g)).toHaveLength(1);
    const table = /READ_ONLY_CALLS = \{([\s\S]*?)\n\} as const/.exec(code('readings.ts'))![1];
    expect([...table.matchAll(/command: '(\w+)', args: \[([^\]]*)\]/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual([
      "ioreg '-c', 'IOHIDSystem', '-d', '4'", "pmset '-g', 'batt'", "ps '-axo', 'args='", "sysctl '-n', 'kern.boottime'",
      "tmux 'list-sessions', '-F', '#{session_name}'", "who '-u'",
    ]);
  });

  it('declares no callable yield on any kind', () => {
    for (const entry of WORK_YIELD_REGISTRY) {
      const members = Object.keys(entry).filter((k) => typeof (entry as unknown as Record<string, unknown>)[k] === 'function');
      expect(members, entry.kind).toEqual(['discover']);
    }
  });

  it('has dependencies that are all reads, with the session manager not among them', () => {
    const source = code('DrainRehearsal.ts');
    const deps = /export interface DrainRehearsalDeps \{([\s\S]*?)\n\}/.exec(source)![1];
    expect(deps).not.toMatch(/SessionManager|LocalVerifyService|JobScheduler|ResumeQueue\b/);
    for (const f of files) expect(code(f), f).not.toMatch(/from '.*(SessionManager|LocalVerifyService|JobScheduler|ResumeQueue|workAdmission)\.js'/);
  });

  it('gives server.ts no path from this feature to an actor', () => {
    const server = fs.readFileSync(path.resolve('src/commands/server.ts'), 'utf-8');
    const start = server.indexOf('── Machine self-maintenance, watch-only');
    const block = server.slice(start, server.indexOf('── Overload admission (trustworthy-machine-load Part C)', start));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(/\.(kill\w*|stop\w*|cancel\w*|enqueue|pause|refresh\w*|restart\w*|sendInput|injectMessage|shutdown)\(/);
    expect(block).not.toMatch(/setAdmissionGate|canRunJob/);
  });

  it('is consulted by no admission path', () => {
    const uses = ['src/core/workAdmission.ts', 'src/scheduler/JobScheduler.ts', 'src/core/SessionManager.ts', 'src/localVerify/LocalVerifyService.ts', 'src/core/hostTestRunnerSemaphore.ts']
      .filter((f) => /machineMaintenance|host-maintenance/.test(fs.readFileSync(path.resolve(f), 'utf-8')));
    expect(uses).toEqual([]);
  });
});

describe('the yield contract covers the spawn chokepoints', () => {
  const CHOKEPOINTS = ['src/core/SessionManager.ts', 'src/scheduler/JobScheduler.ts', 'src/localVerify/LocalVerifyService.ts', 'src/core/hostTestRunnerSemaphore.ts', 'src/core/AutonomousSessions.ts'];

  it('declares a kind at each chokepoint, pointing at a file that exists', () => {
    const declared = new Set(WORK_YIELD_REGISTRY.map((e) => e.spawnChokepoint));
    for (const c of CHOKEPOINTS) expect(declared.has(c), c).toBe(true);
    for (const c of declared) expect(fs.existsSync(path.resolve(c)), c).toBe(true);
  });

  it('gives every kind an offset on the drain sequence and a way back', async () => {
    const { DRAIN_PHASES } = await import('../../src/monitoring/machineMaintenance/planner.js');
    const offsets = DRAIN_PHASES.map((p) => p.offsetMinutes);
    for (const e of WORK_YIELD_REGISTRY) {
      expect(offsets, e.kind).toContain(e.askOffsetMinutes);
      expect(e.maxYieldSeconds, e.kind).toBeGreaterThan(0);
    }
  });
});
