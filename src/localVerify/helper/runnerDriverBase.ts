/**
 * Shared part of the real sandbox drivers (Lima, WSL): everything inside the sandbox goes through
 * one root-owned runner, `/usr/local/sbin/instar-helper-runner` (src/templates/helper/
 * instar-helper-runner.sh), reached through the sandbox's control channel (`limactl shell`, or
 * `wsl.exe -d instar-helper -u root`). The runner starts the build and every slice in new network
 * and mount namespaces (`unshare -m -n`, then its own loopback; a slice also gets one dummy
 * interface that reaches nothing), with AF_VSOCK refused by a seccomp filter, a per-slice overlay
 * on the read-only tree, and the result framed on its own stdout (never read from the overlay).
 * A slice's progress leaves the same way: one line per finished file on a pipe the runner opened,
 * written by a root-owned reporter that is not part of the tree. Packages come only from `install` in a merged commit's
 * tree; they live on the package volume, root-owned and read-only, and are bound read-only into a
 * tree's `node_modules` for the build and every slice.
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
import type { SandboxImageIdentity } from './dryRunRecord.js';
import { HELPER_LANES, HELPER_LIMITS, SHA256_HEX_RE } from './helperProtocol.js';
import type { CommandRunner } from './commandRunner.js';
import {
  PKG_VOLUME_MISSING_EXIT, PROGRESS_PREFIX, forwardProbeChecks, pairedRouteChecks, parseContainmentOutput, parseProgressLine, unframeResult,
  type ContainmentCheck, type ContainmentFacts, type ContainmentReport, type HelperSandboxDriver, type SandboxKind, type SandboxStatus, type TesterRun, type TesterRunSpec,
} from './sandboxDriver.js';

export const SANDBOX_NAME = 'instar-helper';
export const RUNNER_PATH = '/usr/local/sbin/instar-helper-runner';
/** Root-owned files the sandbox's own code loads: outside every tree, read-only to builder and tester. */
export const SANDBOX_LIB_DIR = '/usr/local/lib/instar-helper';
export const PROGRESS_REPORTER_PATH = `${SANDBOX_LIB_DIR}/progress-reporter.mjs`;
export const PROPERTY_PROBE_PATH = `${SANDBOX_LIB_DIR}/property-probe.cjs`;

/**
 * The environment of every host command a driver starts (`limactl`, `wsl.exe`): an allow-list
 * taken from the server's own environment, never the whole of it. The agent server's environment
 * can hold credentials (a GitHub token, an SSH agent socket); the control channel into the sandbox
 * is started without them, so there is nothing for it to forward. `extra` names further variables
 * to carry (and `set` fixed values), per driver.
 */
export const CONTROL_ENV_ALLOW: readonly string[] = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL']);
export function controlChannelEnv(source: NodeJS.ProcessEnv, extra: readonly string[] = [], set: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...CONTROL_ENV_ALLOW, ...extra]) if (typeof source[k] === 'string') out[k] = source[k];
  return { ...out, ...set };
}
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
    // Loaded by a slice's vitest and by the start-up checks: root's own files, never the tree's.
    [PROGRESS_REPORTER_PATH, '0644', read('instar-helper-progress-reporter.mjs')],
    [PROPERTY_PROBE_PATH, '0644', read('instar-helper-property-probe.cjs')],
    ['/etc/instar-helper/builder-egress.nft', '0644', read('builder-egress.nft')],
    ['/etc/instar-helper/pkg-volume.conf', '0644', packageVolumeConf()],
    ...Object.entries(extra).map(([p, c]) => [p, '0644', c] as [string, string, string]),
  ];
  const parts = ['#!/bin/bash', 'set -euo pipefail', `install -d -m 0755 -o root -g root /etc/instar-helper /usr/local/sbin ${SANDBOX_LIB_DIR}`];
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

function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid hash');
}

/**
 * The package volume (spec Build decisions "The package cache survives the daily re-creation"):
 * its own disk beside the sandbox image, never part of it, so deleting and re-creating the sandbox
 * leaves it. The runner mounts it at /srv/nm by its filesystem label; on first use it formats the
 * one empty disk of exactly this size (anything else, and the helper has no packages and refuses).
 */
export const PACKAGE_VOLUME = Object.freeze({ name: 'instar-helper-pkg', label: 'instar-pkg', sizeGb: 12 });

/** /etc/instar-helper/pkg-volume.conf inside the sandbox, read by the runner. */
/** The package volume's full size in bytes (what its disk file may grow to on the host). */
export const PACKAGE_VOLUME_CAP_BYTES = PACKAGE_VOLUME.sizeGb * 1024 ** 3;

export function packageVolumeConf(): string {
  return `PKG_LABEL=${PACKAGE_VOLUME.label}\nPKG_SIZE_BYTES=${PACKAGE_VOLUME.sizeGb * 1024 ** 3}\n`;
}

/**
 * The sandbox settings' hash: every text that shapes the sandbox's walls and size, each framed by
 * its length. The runner and check scripts are not part of it: they are the helper's runner
 * version (spec Build decisions "Version"), which resets evidence by its own rule.
 */
export function sandboxSettingsHash(parts: readonly string[]): string {
  const h = crypto.createHash('sha256');
  h.update('instar-lv-helper-sandbox-settings-v1\n');
  for (const p of parts) { h.update(`${Buffer.byteLength(p)}\n`); h.update(p); h.update('\n'); }
  return h.digest('hex');
}

/** The settings both sandboxes share: the builder's egress rules, the provisioning script, the package volume. */
export function commonSandboxSettings(read: (n: string) => string = readHelperTemplate): string[] {
  return [read('builder-egress.nft'), read('provision-sandbox.sh'), packageVolumeConf()];
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
  /**
   * Environment for every host command this driver starts: the allow-list only (Lima adds
   * LIMA_HOME, WSL what Windows interop needs). Never the server's whole environment.
   */
  protected commandEnv(): NodeJS.ProcessEnv { return controlChannelEnv(process.env); }

  protected async runner_(mode: string, args: string[], opts: { input?: Readable | string; signal?: AbortSignal; timeoutMs?: number; maxStdout?: number; onStdoutLine?: (line: string) => boolean } = {}) {
    const sh = this.rootShell();
    return this.runner.run(sh.cmd, [...sh.args, RUNNER_PATH, mode, ...args], { ...opts, env: this.commandEnv() });
  }

  abstract imageIdentity(size: SandboxSize): Promise<SandboxImageIdentity | null>;

  async copyIn(treeId: string, tar: Readable, opts: { placed?: boolean } = {}): Promise<{ copyMs: number }> {
    assertTreeId(treeId);
    const t = Date.now();
    const r = await this.runner_('copy-in', [treeId, opts.placed ? 'placed' : 'fresh'], { input: tar, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`copy-in failed (${r.code}): ${r.stderr.slice(0, 300)}`);
    return { copyMs: Date.now() - t };
  }

  async verifyPackages(hash: string, manifestDigest: string): Promise<boolean> {
    assertHash(hash); assertHash(manifestDigest);
    const r = await this.runner_('pkg-verify', [hash, manifestDigest], { timeoutMs: 15 * 60_000 });
    return r.code === 0 && /^packages=ok$/m.test(r.stdout);
  }

  async packageVolumeReady(): Promise<boolean> {
    const r = await this.runner_('pkg-volume', [], { timeoutMs: 5 * 60_000 });
    if (r.code === PKG_VOLUME_MISSING_EXIT) return false;
    return r.code === 0 && /^volume=ok$/m.test(r.stdout);
  }

  async discardPackages(hash: string): Promise<void> {
    assertHash(hash);
    await this.runner_('pkg-discard', [hash], { timeoutMs: 10 * 60_000 });
  }

  async installPackages(hash: string, mergedTreeId: string, signal: AbortSignal): Promise<{ exitCode: number | null; manifestDigest: string | null }> {
    assertHash(hash); assertTreeId(mergedTreeId);
    const r = await this.runner_('install', [hash, mergedTreeId], { signal, timeoutMs: 45 * 60_000 });
    const m = /^manifest=([0-9a-f]{64})$/m.exec(r.stdout);
    return { exitCode: r.code, manifestDigest: r.code === 0 && m ? m[1] : null };
  }

  async placePackages(treeId: string, hash: string, manifestDigest: string): Promise<void> {
    assertTreeId(treeId); assertHash(hash); assertHash(manifestDigest);
    const r = await this.runner_('place', [treeId, hash, manifestDigest], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`place failed (${r.code}): ${r.stderr.slice(0, 300)}`);
  }

  async build(treeId: string, signal: AbortSignal): Promise<{ exitCode: number | null }> {
    assertTreeId(treeId);
    const r = await this.runner_('build', [treeId], { signal, timeoutMs: 45 * 60_000 });
    return { exitCode: r.code };
  }

  async sealTree(treeId: string): Promise<void> {
    assertTreeId(treeId);
    const r = await this.runner_('seal', [treeId], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`seal failed (${r.code})`);
  }

  async execAsTester(treeId: string, run: TesterRunSpec): Promise<TesterRun> {
    assertTreeId(treeId);
    if (!(HELPER_LANES as readonly string[]).includes(run.lane)) throw new Error('invalid lane');
    if (!Number.isSafeInteger(run.workers) || run.workers < 1) throw new Error('invalid worker count');
    // One process per slice; integration and end-to-end files run one at a time, as on a run machine.
    if (run.lane !== 'unit' && run.workers !== 1) throw new Error('integration and e2e slices run with one worker');
    // Progress lines are read while the slice runs and never kept; what remains is the framed
    // result: the 4 MB cap plus the frame's own header lines.
    const rootDir = sliceRoot(treeId);
    const onStdoutLine = (line: string): boolean => {
      if (!line.startsWith(`${PROGRESS_PREFIX} `)) return false;
      const p = parseProgressLine(line);
      if (p && run.onProgress) { try { run.onProgress({ ...p, rootDir }); } catch { /* @silent-fallback-ok: a throwing progress reader never breaks the slice; its last answer carries every file */ } }
      return true;
    };
    const r = await this.runner_('test', [treeId, run.lane, String(run.workers), '--', ...run.files], { signal: run.signal, maxStdout: HELPER_LIMITS.resultMaxBytes + 4096, timeoutMs: 30 * 60_000, onStdoutLine });
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
   * The start-up checks. Host side: the configuration shows no mounts and no forwards; a marker
   * file in the owner's home; one-shot probe listeners on host loopback, on every interface, on
   * the host's local-network address and on its tailnet address, each of which must answer a
   * connection made from the host side (the positive control of the paired network test).
   * Sandbox side: the check script reports one line per check, among them the dummy interface, the
   * absent default route, the failed connections from inside a test namespace to those listeners,
   * and the sandbox property test (as `tester` and as `builder`: no host path readable, no host
   * credential reachable). Then a listener started inside a test namespace and one as the guest
   * user must NOT be reachable from the host's 127.0.0.1.
   *
   * Only digests of host credentials are passed in (`facts.credentialDigests`), never a value.
   */
  async checks(facts: ContainmentFacts = {}): Promise<ContainmentReport> {
    const extra: ContainmentCheck[] = [...await this.hostConfigChecks()];
    const marker = path.join(os.homedir(), `.instar-helper-marker-${crypto.randomBytes(6).toString('hex')}`);
    const probes: net.Server[] = [];
    try {
      fs.writeFileSync(marker, 'instar-helper containment marker\n', { mode: 0o600 });
      const loop = await listenProbe('127.0.0.1', probes);
      const anyPort = await listenProbe('0.0.0.0', probes);
      const lan = lanAddress();
      const lanPort = lan ? await listenProbe(lan, probes).catch(() => null) : null;
      const tailnet = tailnetAddress();
      const tailnetPort = tailnet ? await listenProbe(tailnet, probes).catch(() => null) : null;
      const positive = (await canConnect('127.0.0.1', loop)) && (await canConnect('127.0.0.1', anyPort));
      extra.push({ name: 'probe-positive-controls', result: positive ? 'pass' : 'fail', ...(positive ? {} : { detail: 'a host probe listener did not answer from its own side' }) });
      const lanAnswers = lan && lanPort ? await canConnect(lan, lanPort) : false;
      const tailnetAnswers = tailnet && tailnetPort ? await canConnect(tailnet, tailnetPort) : false;
      const digests = (facts.credentialDigests ?? []).filter((d) => SHA256_HEX_RE.test(d)).slice(0, 8);
      const fwdPorts = [freePortGuess(), freePortGuess()];
      const r = await this.runner_('checks', [
        '--host-loopback-port', String(loop), '--host-any-port', String(anyPort),
        '--host-iface-addr', lan ?? 'none', '--host-iface-port', String(lanPort ?? 0),
        '--host-tailnet-addr', tailnet ?? 'none', '--host-tailnet-port', String(tailnetPort ?? 0),
        '--owner-marker', path.basename(marker),
        '--owner-user', ownerUserName(),
        '--credential-digests', digests.length > 0 ? digests.join(',') : 'none',
        '--forward-probe-ports', fwdPorts.join(','),
        ...this.extraCheckArgs(),
      ], { timeoutMs: 5 * 60_000 });
      // Forward probes: the in-sandbox listeners stay up for a few seconds after the script prints its lines.
      const fromTestNs = await canConnect('127.0.0.1', fwdPorts[0]);
      const fromGuest = await canConnect('127.0.0.1', fwdPorts[1]);
      extra.push(...forwardProbeChecks(r.stdout, { fromTestNs, fromGuest }));
      // The paired network test: each in-namespace failure counts only beside its own listener answering from the host.
      extra.push(...pairedRouteChecks(r.stdout, [
        { name: 'testns-no-route-lan', kind: 'local-network', address: lan && lanPort ? lan : null, answeredFromHost: lanAnswers },
        { name: 'testns-no-route-tailnet-listener', kind: 'tailnet', address: tailnet && tailnetPort ? tailnet : null, answeredFromHost: tailnetAnswers },
      ]));
      return parseContainmentOutput(r.code === 0 || r.stdout ? r.stdout : null, this.requiredChecks(), extra);
    } catch (e) {
      return { ok: false, checks: extra, reason: `checks-unrunnable:${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
    } finally {
      for (const s of probes) s.close();
      await removeMarker(marker);
    }
  }
}

/** The owner's login name, as a path segment the property probe looks for (`/home/<name>`, `/Users/<name>`); `none` when unknown or unusual. */
function ownerUserName(): string {
  try {
    const n = os.userInfo().username;
    return /^[A-Za-z0-9._-]{1,64}$/.test(n) ? n : 'none';
  } catch { return 'none'; } // @silent-fallback-ok: without a name the probe still checks the fixed host folders and the marker file
}

async function removeMarker(p: string): Promise<void> {
  try { await SafeFsExecutor.safeRm(p, { force: true, operation: 'local-verify:helper-marker' }); } catch { /* @silent-fallback-ok: a leftover marker file in the owner's home is harmless and re-created with a new name */ }
}

function listenProbe(host: string, keep: net.Server[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => {
      // The prober hangs up the moment it has connected: a reset on this side is the expected end, never an uncaught error.
      c.on('error', () => { /* @silent-fallback-ok: a probe connection that was reset has already answered what it was for (it connected) */ });
      c.end('instar-probe\n');
    });
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
export function lanAddress(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !isTailnetAddress(a.address)) return a.address;
  }
  return null;
}

/** Whether an IPv4 address is in the tailnet range 100.64.0.0/10 (carrier-grade NAT space, which Tailscale uses). */
export function isTailnetAddress(a: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/** The host's tailnet IPv4 address (its private overlay network side), or null. */
export function tailnetAddress(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && isTailnetAddress(a.address)) return a.address;
  }
  return null;
}

function freePortGuess(): number {
  return 40_000 + crypto.randomInt(0, 20_000);
}
