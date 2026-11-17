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

// The one actor (CMT-1199, second slice): RestartActuator.ts holds the restart command lines and
// the single execFile that runs them; HostMaintenanceStore.claimRung calls the spawn it is handed,
// inside the lock. Every other file stays watch-only, so a second way to act fails here.
const ACTUATOR = 'RestartActuator.ts';
// Enrolment (CMT-1200): the owner's tap installs the reboot rule through five pinned sudo calls,
// and readiness reads six pinned, read-only commands. Each is matched exactly below and removed
// before the general checks, so anything else in those files is held to the watch-only rules.
const ENROL = 'EnrolmentController.ts';
const READINESS = 'enrolmentReadiness.ts';
const ENROL_RUNS = [
  "this.deps.run('sudo', ['-n', 'true'])",
  "this.deps.run('sudo', ['-n', 'sh', '-c', script, '_', rule, SUDOERS_RULE_PATH])",
  "this.deps.run('sudo', ['-k'])",
  "this.deps.run('sudo', ['-n', 'cat', SUDOERS_RULE_PATH])",
  "this.deps.run('sudo', ['-n', '-l'])",
];
const READINESS_READS = [
  "input.read('/usr/bin/fdesetup', ['status'])",
  "input.read('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser'])",
  "input.read('/usr/bin/plutil', ['-extract', 'RunAtLoad', 'raw', '-o', '-', plist])",
  "input.read('/usr/bin/findmnt', ['-no', 'SOURCE', '/'])",
  "input.read('/usr/bin/lsblk', ['-s', '-no', 'TYPE', src])",
  "input.read('/usr/bin/loginctl', ['show-user', input.user, '-p', 'Linger'])",
  "input.read('/usr/bin/systemctl', ['--user', 'is-enabled', `instar-${agent}.service`])",
];
// The one root step: validated by visudo, root-owned 0440, renamed into place. Pinned byte for byte.
const ENROL_SCRIPT = "const script = 'set -e; d=$(mktemp -d /etc/sudoers.d/.instar-reboot.XXXXXX); printf \"%s\" \"$1\" > \"$d/r\"; visudo -cf \"$d/r\" >/dev/null; chown root:0 \"$d/r\"; chmod 0440 \"$d/r\"; mv \"$d/r\" \"$2\"; rmdir \"$d\"';";
const strip = (source: string, pinned: string[]) => pinned.reduce((acc, p) => acc.split(p).join(''), source);
const watchOnly = files.filter((f) => f !== ACTUATOR);
const withoutClaimSpawn = (f: string) => {
  if (f === 'HostMaintenanceStore.ts') return code(f).replace('input.spawn();', '');
  if (f === ENROL) return strip(code(f), [...ENROL_RUNS, ENROL_SCRIPT]).replace("'/etc/sudoers.d/instar-reboot'", '');
  if (f === READINESS) return strip(code(f), READINESS_READS);
  return code(f);
};

describe('enrolment acts only through its pinned calls', () => {
  it('the rule install runs exactly the five sudo calls, and readiness only its read-only commands', () => {
    const enrol = code(ENROL);
    expect([...enrol.matchAll(/this\.deps\.run\([^)]*\)/g)].map((m) => m[0])).toEqual(ENROL_RUNS);
    expect(enrol).toContain(ENROL_SCRIPT);
    expect(enrol).toContain("SUDOERS_RULE_PATH = '/etc/sudoers.d/instar-reboot'");
    const readiness = code(READINESS);
    expect([...readiness.matchAll(/input\.read\([^)]*\)/g)].map((m) => m[0])).toEqual(READINESS_READS);
    // Its one execFile is the bounded read runner; it is handed only to readReadiness.
    expect(readiness.match(/execFile\(/g)).toHaveLength(1);
  });
});

describe('machine maintenance acts only through the restart actuator', () => {
  it('holds no restart command outside the actuator', () => {
    for (const f of watchOnly) expect(withoutClaimSpawn(f), f).not.toMatch(/\b(shutdown|reboot|sudo|systemctl|osascript|launchctl)\b/);
  });

  it('holds no way to signal or end a process outside the actuator and the one claimRung spawn', () => {
    expect(code('HostMaintenanceStore.ts').split('input.spawn();')).toHaveLength(2);
    for (const f of watchOnly) expect(withoutClaimSpawn(f), f).not.toMatch(/process\.kill|\.kill\(|killSession|send-keys|sendKeys|sendInput|\bspawn\(|(?<![.\w])exec\(|execSync|spawnSync/);
  });

  it('imports only from an allowlist, so a new reach into the system fails here', () => {
    // topicRef is a pure, read-only formatter; it cannot actuate maintenance work.
    const allowed = new Set(['node:fs', 'node:os', 'node:path', 'node:crypto', '../../core/hostSemaphoreCore.js', '../../core/SafeFsExecutor.js', '../../core/pollIntent.js', '../../messaging/shared/topicRef.js']);
    for (const f of files) {
      const source = code(f);
      for (const m of source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        // readings.ts runs the command table and resolves the shipped canary bundle beside its own module.
        if (spec.startsWith('./') || allowed.has(spec) || (f === 'readings.ts' && (spec === 'node:child_process' || spec === 'node:url')) || ((f === ACTUATOR || f === READINESS) && spec === 'node:child_process')) continue;
        throw new Error(`${f} imports ${spec}`);
      }
      expect(source, f).not.toMatch(/\bfetch\(|\brequire\(/);
    }
  });

  it('runs commands only through the one named table, with exact arguments', () => {
    const users = files.filter((f) => /execFile\b/.test(code(f)));
    expect(users.sort()).toEqual([ACTUATOR, READINESS, 'readings.ts']);
    expect(code('readings.ts').match(/execFile\(/g)).toHaveLength(1);
    // The actuator's command lines are pinned byte for byte in machine-restart-actuator.test.ts.
    expect(code(ACTUATOR).match(/execFile\(/g)).toHaveLength(1);
    const table = /READ_ONLY_CALLS = \{([\s\S]*?)\n\} as const/.exec(code('readings.ts'))![1];
    expect([...table.matchAll(/command: '([\w./-]+)', args: \[([^\]]*)\]/g)].map((m) => `${m[1]} ${m[2]}`).sort()).toEqual([
      // F1 on macOS: LaunchServices opens Instar's own shipped no-UI canary, which quits at once.
      "/usr/bin/open '-g', '-j', WEDGE_CANARY_APP",
      "/usr/bin/stat '-f', '%Su', '/dev/console'",
      "/usr/bin/zprint '-L', 'data.kalloc.1024'",
      "cmd.exe '/c', 'exit', '0'", "ioreg '-c', 'IOHIDSystem', '-d', '4'", "pmset '-g', 'batt'", "ps '-axo', 'args='", "ps '-axo', 'pid=,lstart=,args='",
      // The gentle rung on macOS: the process table read that finds launches left stopped.
      "ps '-axo', 'pid=,uid=,ppid=,stat=,etime=,comm='",
      // F1 on macOS: the process table read that finds a canary left stopped (the canary pile-up).
      "ps '-axo', 'pid=,uid=,stat=,args='",
      "ps '-axo', 'stat='", "sysctl '-n', 'kern.boottime'", "systemd-run '--user', '--quiet', '--wait', '--collect', '/bin/true'",
      "tasklist.exe '/NH', '/FO', 'CSV'", "tmux 'list-sessions', '-F', '#{session_name}'", "who '-u'",
    ]);
    // Every entry is matched above, so nothing else can hide in the table.
    expect(table.match(/command:/g)).toHaveLength(16);
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
    // One exception, pinned to its exact text: the wedge monitor ends Instar's own canary when the
    // process table shows it left stopped (fb-92ed1f8b-3a2). The monitor passes only pids parsed as
    // this login's InstarWedgeCanary executable; this line is the only signal in the block.
    const canaryEnd = "endCanary: (pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },";
    expect(block.split(canaryEnd)).toHaveLength(2);
    // The second, pinned the same way: the gentle rung resumes a launch LaunchServices left
    // stopped (SIGCONT, which continues a process and cannot end one). The monitor passes only
    // pids parsed as this login's stopped app launches, only while the canary itself was left
    // stopped, and only when wedgeRestart.gentleResume is 'on'.
    const gentleResume = "resumeStopped: (pid) => { try { process.kill(pid, 'SIGCONT'); return true; } catch { return false; } },";
    expect(block.split(gentleResume)).toHaveLength(2);
    const rest = block.replace(canaryEnd, '').replace(gentleResume, '');
    expect(rest).not.toMatch(/process\.kill|\.kill\(/);
    expect(rest).not.toMatch(/\.(kill\w*|stop\w*|cancel\w*|enqueue|pause|refresh\w*|restart\w*|sendInput|injectMessage|shutdown)\(/);
    expect(rest).not.toMatch(/setAdmissionGate|canRunJob/);
    // The one restart path in the block: Restart now, started only by the owner's tap. One
    // actuator, dispatched only through the controller's dispatch dep, and the only session
    // notice is Restart now's own, labelled for the security log.
    expect(block.match(/new RestartActuator\(/g)).toHaveLength(1);
    expect(block.match(/\.dispatch\(/g)).toHaveLength(1);
    expect(block).toContain('dispatch: async (input) => { holdsBeforeDispatch = await readHolds(); return actuator.dispatch(input); },');
    expect([...block.matchAll(/injectInternalMessage\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["s.tmuxSession, text, 'machine-restart-now'"]);
  });

  it('is consulted by no admission path', () => {
    const uses = ['src/core/workAdmission.ts', 'src/scheduler/JobScheduler.ts', 'src/core/SessionManager.ts', 'src/localVerify/LocalVerifyService.ts', 'src/core/hostTestRunnerSemaphore.ts']
      .filter((f) => /machineMaintenance|host-maintenance/.test(fs.readFileSync(path.resolve(f), 'utf-8')));
    expect(uses).toEqual([]);
  });
});

describe('the two reads kept outside the maintenance folder cannot act either', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const probes = read('src/core/BrowserCareProbes.ts');
  const lock = read('src/core/MachineLockStateReader.ts');

  it('hold no restart command and no way to signal or end a process', () => {
    for (const [f, src] of [['BrowserCareProbes.ts', probes], ['MachineLockStateReader.ts', lock]]) {
      expect(src, f).not.toMatch(/\b(shutdown|reboot|sudo|systemctl|launchctl|osascript)\b/);
      expect(src, f).not.toMatch(/process\.kill|\.kill\(|killSession|send-keys|sendKeys|sendInput|\bspawn\(|(?<![.\w])exec\(|execSync|spawnSync|\bfetch\(|\brequire\(/);
      expect(src, f).not.toMatch(/writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|SafeFsExecutor/);
    }
  });

  it('run only their named read-only commands, with fixed arguments', () => {
    expect(probes.match(/execFile\(/g)).toHaveLength(1);
    expect(probes).toMatch(/execFile\('\/bin\/bash', \[script, userDataDir\]/);
    expect(probes).toMatch(/'chrome-unsaved\.sh'\)/);
    expect(lock.match(/execFile\(/g)).toHaveLength(2);
    expect(lock).toMatch(/execFile\(DEFAULT_MAC_DESKTOP_HELPER, \['probe'\]/);
    expect(lock).toMatch(/execFile\('\/usr\/sbin\/sysadminctl', \['-screenLock', 'status'\]/);
  });

  it('imports only from an allowlist', () => {
    const allowed: Record<string, string[]> = {
      'BrowserCareProbes.ts': ['node:child_process', 'node:fs', 'node:os', 'node:path', '../monitoring/machineMaintenance/BrowserCare.js'],
      'MachineLockStateReader.ts': ['node:child_process', 'node:fs', './MacDesktopHost.js', './wslPlatform.js', '../monitoring/machineMaintenance/lockState.js'],
    };
    for (const [f, src] of [['BrowserCareProbes.ts', probes], ['MachineLockStateReader.ts', lock]] as const) {
      for (const m of src.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) expect(allowed[f], `${f} imports ${m[1]}`).toContain(m[1]);
    }
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
