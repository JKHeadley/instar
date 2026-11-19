/**
 * Shared part of the real sandbox drivers (Lima, WSL): everything inside the sandbox goes through
 * one root-owned runner, `/usr/local/sbin/instar-helper-runner` (src/templates/helper/
 * instar-helper-runner.sh), reached through the sandbox's control channel (`limactl shell`, or
 * `wsl.exe -d instar-helper -u root`). The runner starts the build and every slice in new network
 * and mount namespaces (`unshare -m -n`, then `ip link set lo up`), with AF_VSOCK refused by a
 * seccomp filter, a per-slice overlay on the read-only tree, and the result framed on its own
 * stdout (never read from the overlay).
 *
 * NEVER executed on a Local Verify machine: these drivers are selected only on a helper whose
 * owner enabled the role, and every test injects a recording CommandRunner.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { SandboxSize } from './helperConfig.js';
import { HELPER_LIMITS } from './helperProtocol.js';
import type { CommandRunner } from './commandRunner.js';
import { forwardProbeChecks, parseContainmentOutput, unframeResult, type ContainmentCheck, type ContainmentReport, type HelperSandboxDriver, type SandboxKind, type SandboxStatus, type TesterRun } from './sandboxDriver.js';

export const SANDBOX_NAME = 'instar-helper';
export const RUNNER_PATH = '/usr/local/sbin/instar-helper-runner';
export const TREE_ID_RE = /^[0-9a-f]{12,40}$/;
/**
 * The nft table hash strips counter VALUES token by token, never whole lines: `nft list` prints an
 * anonymous counter inline on its rule (`meta skuid 61001 counter packets 0 bytes 0 accept`), so
 * dropping lines would drop that rule from the hash. The runner's `nft_hash` uses this exact sed.
 */
export const NFT_COUNTER_SED = 's/packets [0-9]+ bytes [0-9]+//g';
export function normalizeNftListing(listing: string): string {
  return listing.replace(/packets [0-9]+ bytes [0-9]+/g, '');
}

/** Where the runner mounts a slice's overlay (the report's file names are under it). */
export const sliceRoot = (treeId: string): string => `/srv/slice/${treeId}`;

/** Shipped sandbox files (Lima template, WSL setup, runner, checks, egress rules). */
export function helperTemplatePath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'templates', 'helper', name), // src/localVerify/helper → src/templates/helper
    path.resolve(here, '..', '..', '..', 'src', 'templates', 'helper', name), // dist/localVerify/helper → src/templates/helper
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

export function readHelperTemplate(name: string): string {
  return fs.readFileSync(helperTemplatePath(name), 'utf-8');
}

/**
 * One bash script that writes the runner, the check script and the builder egress rules into the
 * sandbox, then runs the provisioning script (users, nftables table, systemd units). Pure apart
 * from reading the templates.
 */
export function buildProvisionBundle(read: (n: string) => string = readHelperTemplate, extra: Record<string, string> = {}): string {
  const files: Array<[string, string, string]> = [
    ['/usr/local/sbin/instar-helper-runner', '0755', read('instar-helper-runner.sh')],
    ['/usr/local/sbin/instar-helper-checks', '0755', read('instar-helper-checks.sh')],
    ['/etc/instar-helper/builder-egress.nft', '0644', read('builder-egress.nft')],
    ...Object.entries(extra).map(([p, c]) => [p, '0644', c] as [string, string, string]),
  ];
  const parts = ['#!/bin/bash', 'set -euo pipefail', 'install -d -m 0755 /etc/instar-helper /usr/local/sbin'];
  files.forEach(([p, mode, content], i) => {
    const tag = `INSTAR_HELPER_EOF_${i}`;
    if (content.split('\n').includes(tag)) throw new Error(`template contains its own heredoc terminator: ${p}`);
    parts.push(`cat > '${p}' <<'${tag}'`, content.replace(/\n$/, ''), tag, `chown root:root '${p}'`, `chmod ${mode} '${p}'`);
  });
  parts.push(read('provision-sandbox.sh'));
  return parts.join('\n') + '\n';
}

function assertTreeId(treeId: string): void {
  if (!TREE_ID_RE.test(treeId)) throw new Error(`invalid tree id: ${treeId}`);
}

export abstract class RunnerDriverBase implements HelperSandboxDriver {
  abstract readonly kind: SandboxKind;
  protected constructor(protected readonly runner: CommandRunner) {}

  /** The command and argument prefix that runs a command as root inside the sandbox. */
  protected abstract rootShell(): { cmd: string; args: string[] };
  abstract create(size: SandboxSize): Promise<void>;
  abstract start(): Promise<{ startMs: number }>;
  abstract stop(): Promise<void>;
  abstract status(): Promise<SandboxStatus>;
  abstract uninstall(): Promise<void>;
  abstract destroy(): Promise<void>;
  /** Host-side configuration checks (no mounts, no forwards) and the required check names. */
  protected abstract hostConfigChecks(): Promise<ContainmentCheck[]>;
  protected abstract requiredChecks(): readonly string[];
  /** Extra arguments for the in-sandbox check script (e.g. the Echo-distro probe on Windows). */
  protected extraCheckArgs(): string[] { return []; }
  /** Environment for the control-channel command (Lima needs LIMA_HOME). */
  protected commandEnv(): NodeJS.ProcessEnv | undefined { return undefined; }

  protected async runner_(mode: string, args: string[], opts: { input?: Readable | string; signal?: AbortSignal; timeoutMs?: number; maxStdout?: number } = {}) {
    const sh = this.rootShell();
    const env = this.commandEnv();
    return this.runner.run(sh.cmd, [...sh.args, RUNNER_PATH, mode, ...args], { ...opts, ...(env ? { env } : {}) });
  }

  async copyIn(treeId: string, tar: Readable): Promise<{ copyMs: number }> {
    assertTreeId(treeId);
    const t = Date.now();
    const r = await this.runner_('copy-in', [treeId], { input: tar, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`copy-in failed (${r.code}): ${r.stderr.slice(0, 300)}`);
    return { copyMs: Date.now() - t };
  }

  async execAsBuilder(treeId: string, step: 'npm-ci' | 'build', signal: AbortSignal): Promise<{ exitCode: number | null }> {
    assertTreeId(treeId);
    const r = await this.runner_(step, [treeId], { signal, timeoutMs: 45 * 60_000 });
    return { exitCode: r.code };
  }

  async sealTree(treeId: string): Promise<void> {
    assertTreeId(treeId);
    const r = await this.runner_('seal', [treeId], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`seal failed (${r.code})`);
  }

  async execAsTester(treeId: string, run: { files: string[]; workers: number; signal: AbortSignal }): Promise<TesterRun> {
    assertTreeId(treeId);
    if (!Number.isSafeInteger(run.workers) || run.workers < 1) throw new Error('invalid worker count');
    // The 4 MB cap plus the frame's own header lines.
    const r = await this.runner_('test', [treeId, String(run.workers), '--', ...run.files], { signal: run.signal, maxStdout: HELPER_LIMITS.resultMaxBytes + 4096, timeoutMs: 30 * 60_000 });
    const rootDir = sliceRoot(treeId);
    if (r.oversize) return { rootDir, exitCode: r.code, resultText: null, oversize: r.oversize, unhandledErrors: 0, vitestStartMs: null };
    const f = unframeResult(r.stdout);
    if (!f) return { rootDir, exitCode: r.code, resultText: null, unhandledErrors: 0, vitestStartMs: null };
    return { rootDir, exitCode: f.exitCode, resultText: f.report || null, unhandledErrors: f.unhandledErrors, vitestStartMs: f.vitestStartMs };
  }

  async reap(): Promise<{ survivors: number }> {
    const r = await this.runner_('reap', [], { timeoutMs: 30_000 });
    const m = /survivors=(\d+)/.exec(r.stdout);
    return { survivors: m ? Number(m[1]) : (r.code === 0 ? 0 : 1) };
  }

  async removeTree(treeId: string): Promise<void> {
    assertTreeId(treeId);
    await this.runner_('remove', [treeId], { timeoutMs: 10 * 60_000 });
  }

  async sandboxFreeBytes(): Promise<number | null> {
    const r = await this.runner_('free', [], { timeoutMs: 30_000 });
    const m = /free_bytes=(\d+)/.exec(r.stdout);
    return r.code === 0 && m ? Number(m[1]) : null;
  }

  async sandboxBusyCores(): Promise<number | null> { return null; }

  /**
   * B2 checks. Host side: the configuration shows no mounts and no forwards, a marker in the
   * owner's home, one-shot probe listeners on host loopback and the host's LAN address (each must
   * answer from its own side: the positive control). Sandbox side: the check script reports one
   * line per check. Then a listener started inside a test namespace and one as the guest user
   * must NOT be reachable from the host's 127.0.0.1.
   */
  async checks(): Promise<ContainmentReport> {
    const extra: ContainmentCheck[] = [...await this.hostConfigChecks()];
    const marker = path.join(os.homedir(), `.instar-helper-marker-${crypto.randomBytes(6).toString('hex')}`);
    const probes: net.Server[] = [];
    try {
      fs.writeFileSync(marker, 'instar-helper containment marker\n', { mode: 0o600 });
      const loop = await listenProbe('127.0.0.1', probes);
      const anyPort = await listenProbe('0.0.0.0', probes);
      const lan = lanAddress();
      const lanPort = lan ? await listenProbe(lan, probes) : null;
      const positive = (await canConnect('127.0.0.1', loop)) && (await canConnect('127.0.0.1', anyPort)) && (lan && lanPort ? await canConnect(lan, lanPort) : false);
      extra.push({ name: 'probe-positive-controls', result: positive ? 'pass' : 'fail', ...(positive ? {} : { detail: 'a host probe listener did not answer from its own side' }) });
      const fwdPorts = [freePortGuess(), freePortGuess()];
      const r = await this.runner_('checks', [
        '--host-loopback-port', String(loop), '--host-any-port', String(anyPort),
        '--host-iface-addr', lan ?? 'none', '--host-iface-port', String(lanPort ?? 0),
        '--owner-marker', path.basename(marker),
        '--forward-probe-ports', fwdPorts.join(','),
        ...this.extraCheckArgs(),
      ], { timeoutMs: 3 * 60_000 });
      // Forward probes: the in-sandbox listeners stay up for a few seconds after the script prints its lines.
      const fromTestNs = await canConnect('127.0.0.1', fwdPorts[0]);
      const fromGuest = await canConnect('127.0.0.1', fwdPorts[1]);
      extra.push(...forwardProbeChecks(r.stdout, { fromTestNs, fromGuest }));
      return parseContainmentOutput(r.code === 0 || r.stdout ? r.stdout : null, this.requiredChecks(), extra);
    } catch (e) {
      return { ok: false, checks: extra, reason: `checks-unrunnable:${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
    } finally {
      for (const s of probes) s.close();
      await removeMarker(marker);
    }
  }
}

async function removeMarker(p: string): Promise<void> {
  try { await SafeFsExecutor.safeRm(p, { force: true, operation: 'local-verify:helper-marker' }); } catch { /* @silent-fallback-ok: a leftover marker file in the owner's home is harmless and re-created with a new name */ }
}

function listenProbe(host: string, keep: net.Server[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => { c.end('instar-probe\n'); });
    s.once('error', reject);
    s.listen(0, host, () => { keep.push(s); resolve((s.address() as net.AddressInfo).port); });
  });
}

export function canConnect(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect({ host, port });
    const t = setTimeout(() => { c.destroy(); resolve(false); }, timeoutMs);
    c.once('connect', () => { clearTimeout(t); c.destroy(); resolve(true); });
    c.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

/** The host's first non-internal IPv4 address (its LAN side), or null. */
export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address;
  }
  return null;
}

function freePortGuess(): number {
  return 40_000 + crypto.randomInt(0, 20_000);
}
