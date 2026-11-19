/**
 * Windows sandbox: a dedicated WSL2 distro `instar-helper`, separate from the Echo distro, driven
 * by the Echo agent already enrolled on that PC with `wsl.exe -d instar-helper`
 * (docs/specs/local-verify-borrowed-unit-slices.md, B and B2).
 *
 * WSL2 distros share one kernel and (in NAT mode) one network, so the Windows boundary is
 * container-level; the runner's per-process walls (no-network namespaces, private mount view,
 * AF_VSOCK refused, builder egress matched by uid) are what separate tests from Echo's distro.
 * CPU, memory and task limits are a systemd scope's CPUQuota / MemoryMax / TasksMax; the distro's
 * disk is capped with `wsl --manage instar-helper --resize`.
 *
 * Stopping is ALWAYS `wsl --terminate instar-helper`, never `wsl --shutdown` (that would stop Echo).
 * Uninstall is `wsl --unregister instar-helper`, never Echo's distro.
 *
 * NEVER executed on a Local Verify machine (see runnerDriverBase.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { SandboxSize } from './helperConfig.js';
import type { CommandRunner } from './commandRunner.js';
import { REQUIRED_CHECKS_WSL, type ContainmentCheck, type SandboxStatus } from './sandboxDriver.js';
import { RunnerDriverBase, SANDBOX_NAME, buildProvisionBundle, readHelperTemplate } from './runnerDriverBase.js';

export const OWNER_SIGNAL_TASK = '\\Instar\\OwnerSignal';

/**
 * The helper distro's minimal base root filesystem, pinned by digest (B2.5). Set by the operator on
 * the Windows throwaway rung from the image it verified; until then `create` refuses
 * (`image-digest-unpinned`), and any other file refuses `image-digest-mismatch`.
 */
export const WSL_BASE_IMAGE: Readonly<{ sha256: string | null }> = Object.freeze({ sha256: null });

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface WslDriverOpts {
  runner: CommandRunner;
  wslExe?: string;
  /** Windows folder the distro is imported into (its virtual disk lives there). */
  installDir: string;
  /** The pinned base root filesystem tar, as wsl.exe sees it (a Windows path). */
  rootfsTar: string;
  /** The same tar as this process can read it (e.g. under /mnt/c), for the digest check before import. */
  rootfsTarLocal: string;
  /** The expected sha256 (default WSL_BASE_IMAGE.sha256). */
  rootfsSha256?: string | null;
  hashFile?: (file: string) => Promise<string>;
  /** The owner-signal file in Echo's distro (`~/.instar/state/helper-owner-signal.json`). */
  signalFile: string;
  now?: () => number;
}

/** `wsl -l -v` prints UTF-16LE; decoded as UTF-8 it carries NULs. */
export function parseWslList(out: string): Array<{ name: string; state: string }> {
  const rows: Array<{ name: string; state: string }> = [];
  for (const raw of out.replace(/\u0000/g, '').split(/\r?\n/)) {
    const m = /^\s*\*?\s*(\S+)\s+(Running|Stopped|Installing|Converting|Uninstalling)\s+\d+\s*$/.exec(raw);
    if (m) rows.push({ name: m[1], state: m[2] });
  }
  return rows;
}

/** /etc/wsl.conf of the helper distro: automount and Windows interop off. */
export function wslConfChecks(text: string | null): ContainmentCheck[] {
  if (text === null) return [
    { name: 'config-no-mounts', result: 'unrunnable', detail: 'wsl.conf unreadable' },
    { name: 'config-no-forwards', result: 'unrunnable', detail: 'wsl.conf unreadable' },
  ];
  const sections = new Map<string, Map<string, string>>();
  let cur = '';
  for (const line of text.split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (s) { cur = s[1].trim().toLowerCase(); continue; }
    const kv = /^\s*([A-Za-z]+)\s*=\s*(\S+)\s*$/.exec(line);
    if (kv) { const m = sections.get(cur) ?? new Map(); m.set(kv[1].toLowerCase(), kv[2].toLowerCase()); sections.set(cur, m); }
  }
  const get = (sec: string, k: string) => sections.get(sec)?.get(k) ?? null;
  const noMount = get('automount', 'enabled') === 'false' && get('automount', 'mountfstab') === 'false';
  const noInterop = get('interop', 'enabled') === 'false' && get('interop', 'appendwindowspath') === 'false';
  return [
    { name: 'config-no-mounts', result: noMount && noInterop ? 'pass' : 'fail', ...(noMount && noInterop ? {} : { detail: `automount=${String(noMount)} interop=${String(noInterop)}` }) },
    // WSL has no per-distro forward setting; the runtime probes (no-forward-from-testns / guest user) decide.
    { name: 'config-no-forwards', result: 'pass', detail: 'wsl: no per-distro forwards; runtime probes decide' },
  ];
}

export class WslDriver extends RunnerDriverBase {
  readonly kind = 'wsl' as const;
  private readonly wsl: string;
  private lastCpu: { usec: number; at: number } | null = null;

  constructor(private readonly o: WslDriverOpts) {
    super(o.runner);
    this.wsl = o.wslExe ?? 'wsl.exe';
  }

  protected rootShell(): { cmd: string; args: string[] } { return { cmd: this.wsl, args: ['-d', SANDBOX_NAME, '-u', 'root', '--'] }; }
  protected requiredChecks(): readonly string[] { return REQUIRED_CHECKS_WSL; }
  protected extraCheckArgs(): string[] { return ['--wsl']; }

  private run(args: string[], timeoutMs = 10 * 60_000, input?: string) {
    // Only ever this distro's name, or the import/resize/unregister/terminate verbs that name it.
    return this.runner.run(this.wsl, args, { timeoutMs, ...(input !== undefined ? { input } : {}) });
  }

  async create(size: SandboxSize): Promise<void> {
    const want = this.o.rootfsSha256 !== undefined ? this.o.rootfsSha256 : WSL_BASE_IMAGE.sha256;
    if (!want) throw new Error('image-digest-unpinned');
    let got: string | null = null;
    try { got = await (this.o.hashFile ?? sha256File)(this.o.rootfsTarLocal); } catch { got = null; } // @silent-fallback-ok: an unreadable image refuses below as a mismatch
    if (got !== want.toLowerCase()) throw new Error('image-digest-mismatch');
    const imp = await this.run(['--import', SANDBOX_NAME, this.o.installDir, this.o.rootfsTar, '--version', '2']);
    if (imp.code !== 0) throw new Error(`wsl --import failed (${imp.code})`);
    const rs = await this.run(['--manage', SANDBOX_NAME, '--resize', `${size.diskGb}GB`]);
    if (rs.code !== 0) throw new Error('wsl-resize-unsupported'); // the operator imports a disk created at that size (spec B2.2)
    const scope = `CPUQuota=${size.cpus * 100}%\nMemoryMax=${size.memoryGb}G\nTasksMax=4096\n`;
    const p = await this.run([...this.rootShell().args, 'bash', '-s'], 30 * 60_000, buildProvisionBundle(readHelperTemplate, {
      '/etc/wsl.conf': readHelperTemplate('wsl.conf'),
      '/etc/instar-helper/scope.conf': scope,
    }));
    if (p.code !== 0) throw new Error(`provision failed (${p.code})`);
    await this.stop(); // wsl.conf applies on the next start
  }

  async start(): Promise<{ startMs: number }> {
    const t = Date.now();
    const r = await this.run([...this.rootShell().args, 'true'], 5 * 60_000);
    if (r.code !== 0) throw new Error(`wsl start failed (${r.code})`);
    return { startMs: Date.now() - t };
  }

  async stop(): Promise<void> {
    await this.run(['--terminate', SANDBOX_NAME], 2 * 60_000);
  }

  async status(): Promise<SandboxStatus> {
    const r = await this.run(['-l', '-v'], 30_000);
    const row = parseWslList(r.stdout).find((x) => x.name === SANDBOX_NAME);
    return { exists: !!row, running: row?.state === 'Running', diskFileBytes: null, peakMemMb: null };
  }

  /** The helper scope's own CPU (cpu.stat usage_usec deltas), so Echo's load still counts as the owner's. */
  async sandboxBusyCores(): Promise<number | null> {
    const r = await this.runner_('cpu-stat', [], { timeoutMs: 5_000 });
    const m = /usage_usec\s+(\d+)/.exec(r.stdout);
    if (r.code !== 0 || !m) return null;
    const now = (this.o.now ?? Date.now)();
    const usec = Number(m[1]);
    const prev = this.lastCpu;
    this.lastCpu = { usec, at: now };
    if (!prev || now <= prev.at || usec < prev.usec) return 0;
    return (usec - prev.usec) / 1000 / (now - prev.at);
  }

  protected async hostConfigChecks(): Promise<ContainmentCheck[]> {
    const conf = await this.run([...this.rootShell().args, 'cat', '/etc/wsl.conf'], 30_000);
    const checks = wslConfChecks(conf.code === 0 ? conf.stdout : null);
    let fresh = false;
    try { fresh = (this.o.now ?? Date.now)() - fs.statSync(this.o.signalFile).mtimeMs <= 10_000; } catch { fresh = false; } // @silent-fallback-ok: no signal file fails the check
    checks.push({ name: 'owner-signal-updates', result: fresh ? 'pass' : 'fail', ...(fresh ? {} : { detail: 'owner signal missing or older than 10 s' }) });
    return checks;
  }

  async destroy(): Promise<void> {
    await this.run(['--terminate', SANDBOX_NAME], 2 * 60_000);
    await this.run(['--unregister', SANDBOX_NAME], 5 * 60_000);
  }

  /** `wsl --unregister instar-helper` (never Echo's distro), the owner-signal task and its file. */
  async uninstall(): Promise<void> {
    await this.destroy();
    await this.runner.run('schtasks.exe', ['/Delete', '/TN', OWNER_SIGNAL_TASK, '/F'], { timeoutMs: 60_000 });
    await SafeFsExecutor.safeRm(this.o.signalFile, { force: true, operation: 'local-verify:helper-uninstall' });
  }
}
