/**
 * macOS sandbox: a Lima virtual machine `instar-helper` on Apple's Virtualization framework
 * (docs/specs/local-verify-borrowed-unit-slices.md, B and B2). Installed and run at user level
 * from a pinned Lima release in the agent's home; its disk lives under `~/.instar-helper/`.
 *
 * Created from src/templates/helper/lima-instar-helper.yaml: `mounts: []` (overriding Lima's
 * default read-only home mount), `portForwards: [{guestPortRange: [1, 65535], ignore: true}]`,
 * `ssh.forwardAgent: false`, a minimal image pinned by digest, and the fixed size.
 *
 * NEVER executed on a Local Verify machine (see runnerDriverBase.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { SandboxSize } from './helperConfig.js';
import type { CommandRunner } from './commandRunner.js';
import { REQUIRED_CHECKS_COMMON, type ContainmentCheck, type SandboxStatus } from './sandboxDriver.js';
import { RunnerDriverBase, SANDBOX_NAME, buildProvisionBundle, readHelperTemplate } from './runnerDriverBase.js';

export { buildProvisionBundle };

export interface LimaDriverOpts {
  runner: CommandRunner;
  /** The pinned limactl binary installed in the agent's home. */
  limactl: string;
  /** `~/.instar-helper` (outside the agent home: nothing syncs, indexes or shows it). */
  helperHome?: string;
}

export function defaultHelperHome(): string {
  return path.join(os.homedir(), '.instar-helper');
}

/**
 * The minimal base image, pinned by digest. The digest is set by the operator on the throwaway
 * (Linux/macOS proof) rung from the image it verified; until then `create` refuses
 * (`image-digest-unpinned`) rather than boot an unpinned image.
 */
export const LIMA_BASE_IMAGE: Readonly<{ url: string; digest: string | null }> = Object.freeze({
  url: 'https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-arm64.img',
  digest: null,
});

/** Render the shipped Lima template for a size. Pure apart from reading the template. */
export function renderLimaTemplate(size: SandboxSize, template: string = readHelperTemplate('lima-instar-helper.yaml'), image: { url: string; digest: string | null } = LIMA_BASE_IMAGE): string {
  return template
    .replace(/\{\{IMAGE_URL\}\}/g, image.url)
    .replace(/\{\{IMAGE_DIGEST\}\}/g, image.digest ?? 'UNPINNED')
    .replace(/\{\{CPUS\}\}/g, String(size.cpus))
    .replace(/\{\{MEMORY_GB\}\}/g, String(size.memoryGb))
    .replace(/\{\{DISK_GB\}\}/g, String(size.diskGb));
}

/** Host-side B2.1 checks over a Lima instance config: no mounts, every guest port ignored, no agent forwarding. */
export function limaConfigChecks(yamlText: string | null): ContainmentCheck[] {
  if (yamlText === null) return [
    { name: 'config-no-mounts', result: 'unrunnable', detail: 'instance config unreadable' },
    { name: 'config-no-forwards', result: 'unrunnable', detail: 'instance config unreadable' },
  ];
  let cfg: Record<string, unknown>;
  try { cfg = (yaml.load(yamlText) ?? {}) as Record<string, unknown>; } catch {
    return [
      { name: 'config-no-mounts', result: 'unrunnable', detail: 'instance config not YAML' },
      { name: 'config-no-forwards', result: 'unrunnable', detail: 'instance config not YAML' },
    ];
  }
  const mounts = cfg.mounts;
  const mountsOk = Array.isArray(mounts) && mounts.length === 0;
  const pf = Array.isArray(cfg.portForwards) ? cfg.portForwards as Array<Record<string, unknown>> : [];
  const first = pf[0];
  const range = first && Array.isArray(first.guestPortRange) ? first.guestPortRange as unknown[] : null;
  const ignoresAll = !!first && first.ignore === true && !!range && range[0] === 1 && range[1] === 65535;
  const ssh = (cfg.ssh ?? {}) as Record<string, unknown>;
  const noAgent = ssh.forwardAgent === false;
  const noReverse = !(Array.isArray(cfg.portForwards) && pf.some((r) => r.reverse === true));
  // plain mode (no guest agent, no forwarding) and no extra networks are part of the wall too.
  const plain = cfg.plain === true;
  const noNetworks = cfg.networks === undefined || (Array.isArray(cfg.networks) && cfg.networks.length === 0);
  return [
    { name: 'config-no-mounts', result: mountsOk ? 'pass' : 'fail', ...(mountsOk ? {} : { detail: 'mounts is not an empty list' }) },
    { name: 'config-no-forwards', result: ignoresAll && noAgent && noReverse && plain && noNetworks ? 'pass' : 'fail', ...(ignoresAll && noAgent && noReverse && plain && noNetworks ? {} : { detail: `ignoreAll=${ignoresAll} forwardAgent=${String(ssh.forwardAgent)} reverse=${!noReverse} plain=${plain} networks=${!noNetworks}` }) },
  ];
}

export class LimaDriver extends RunnerDriverBase {
  readonly kind = 'lima' as const;
  private readonly helperHome: string;
  private peakMemMb: number | null = null;

  constructor(private readonly o: LimaDriverOpts) {
    super(o.runner);
    this.helperHome = o.helperHome ?? defaultHelperHome();
  }

  private limaHome(): string { return path.join(this.helperHome, 'lima'); }
  protected commandEnv(): NodeJS.ProcessEnv { return { ...process.env, LIMA_HOME: this.limaHome() }; }
  protected rootShell(): { cmd: string; args: string[] } { return { cmd: this.o.limactl, args: ['shell', '--workdir', '/', SANDBOX_NAME, 'sudo', '-n'] }; }
  protected requiredChecks(): readonly string[] { return REQUIRED_CHECKS_COMMON; }

  private lima(args: string[], timeoutMs = 10 * 60_000, input?: string) {
    return this.runner.run(this.o.limactl, args, { env: this.commandEnv(), timeoutMs, ...(input !== undefined ? { input } : {}) });
  }

  async create(size: SandboxSize): Promise<void> {
    if (!fs.existsSync(this.o.limactl)) throw new Error('lima-not-installed');
    if (!LIMA_BASE_IMAGE.digest) throw new Error('image-digest-unpinned');
    fs.mkdirSync(this.limaHome(), { recursive: true, mode: 0o700 });
    const file = path.join(this.helperHome, 'instar-helper.yaml');
    fs.writeFileSync(file, renderLimaTemplate(size), { mode: 0o600 });
    const c = await this.lima(['create', `--name=${SANDBOX_NAME}`, '--tty=false', file]);
    if (c.code !== 0) throw new Error(`limactl create failed (${c.code}): ${c.stderr.slice(0, 300)}`);
    await this.start();
    const p = await this.lima(['shell', '--workdir', '/', SANDBOX_NAME, 'sudo', '-n', 'bash', '-s'], 30 * 60_000, buildProvisionBundle());
    if (p.code !== 0) throw new Error(`provision failed (${p.code}): ${p.stderr.slice(0, 300)}`);
  }

  async start(): Promise<{ startMs: number }> {
    const t = Date.now();
    const r = await this.lima(['start', '--tty=false', SANDBOX_NAME]);
    if (r.code !== 0) throw new Error(`limactl start failed (${r.code})`);
    return { startMs: Date.now() - t };
  }

  async stop(): Promise<void> {
    await this.lima(['stop', SANDBOX_NAME], 2 * 60_000);
  }

  async status(): Promise<SandboxStatus> {
    const r = await this.lima(['list', '--json'], 30_000);
    let running = false;
    let exists = false;
    for (const line of r.stdout.split('\n')) {
      try {
        const o = JSON.parse(line) as { name?: string; status?: string };
        if (o.name === SANDBOX_NAME) { exists = true; running = o.status === 'Running'; }
      } catch { /* @silent-fallback-ok: a non-JSON line is not an instance */ }
    }
    let diskFileBytes: number | null = null;
    try { diskFileBytes = fs.statSync(path.join(this.limaHome(), SANDBOX_NAME, 'diffdisk')).blocks * 512; } catch { diskFileBytes = null; } // @silent-fallback-ok: unknown size fails the host-disk check (refuse)
    const ps = await this.runner.run('ps', ['-A', '-o', 'rss=,comm='], { timeoutMs: 5_000 });
    let rssKb = 0;
    for (const line of ps.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && /com\.apple\.Virtualization\.VirtualMachine/.test(m[2])) rssKb += Number(m[1]);
    }
    if (rssKb > 0) this.peakMemMb = Math.max(this.peakMemMb ?? 0, Math.round(rssKb / 1024));
    return { exists, running, diskFileBytes, peakMemMb: this.peakMemMb };
  }

  protected async hostConfigChecks(): Promise<ContainmentCheck[]> {
    let text: string | null = null;
    try { text = fs.readFileSync(path.join(this.limaHome(), SANDBOX_NAME, 'lima.yaml'), 'utf-8'); } catch { text = null; } // @silent-fallback-ok: unreadable config → unrunnable checks → refuse
    return limaConfigChecks(text);
  }

  async destroy(): Promise<void> {
    await this.lima(['stop', '--force', SANDBOX_NAME], 2 * 60_000);
    await this.lima(['delete', '--force', SANDBOX_NAME], 2 * 60_000);
  }

  /** Removes the VM and its disk, the helper home (Lima's state under it) and the pinned Lima install. */
  async uninstall(): Promise<void> {
    await this.destroy();
    await SafeFsExecutor.safeRm(this.helperHome, { recursive: true, force: true, operation: 'local-verify:helper-uninstall' });
    const limaInstall = path.dirname(path.dirname(this.o.limactl));
    if (path.basename(limaInstall) === 'lima' && limaInstall.includes(`${path.sep}helper${path.sep}`)) {
      await SafeFsExecutor.safeRm(limaInstall, { recursive: true, force: true, operation: 'local-verify:helper-uninstall' });
    }
  }
}
