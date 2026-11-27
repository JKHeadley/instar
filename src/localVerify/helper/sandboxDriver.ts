/**
 * The seam between the helper service and the sandbox its tests run in
 * (docs/specs/local-verify-borrowed-unit-slices.md, B and B2). Tests NEVER run on the helper's own
 * operating system: macOS uses a Lima VM (limaDriver.ts), Windows a dedicated WSL2 distro
 * (wslDriver.ts). Unit tests use a FakeSandboxDriver; the e2e suite uses the named test-only
 * `test-bypass` driver, which production setup can never select.
 *
 * Every OS/sandbox interaction goes through this interface.
 */
import type { Readable } from 'node:stream';
import type { SandboxSize } from './helperConfig.js';
import { HELPER_LIMITS, type HelperLane } from './helperProtocol.js';
import type { SandboxImageIdentity } from './dryRunRecord.js';

export type SandboxKind = 'lima' | 'wsl' | 'fake' | 'test-bypass';

export interface SandboxStatus {
  exists: boolean;
  running: boolean;
  /** Current size of the sandbox's disk file on the host, bytes; null unknown. */
  diskFileBytes: number | null;
  /** Peak host memory the sandbox used, MB; null unknown. */
  peakMemMb: number | null;
  /**
   * Current size of the package volume's disk file on the host, bytes; null unknown. It is its own
   * disk beside the sandbox image and grows on the same host disk, so the host-disk margin counts
   * its remaining growth too. Null reads as nothing written yet (the whole cap may still grow).
   */
  pkgDiskFileBytes?: number | null;
  /** The package volume's full size, bytes. Absent: this driver keeps no package disk on the host. */
  pkgDiskCapBytes?: number;
}

/** The host facts a start-up check needs that the driver cannot know by itself. */
export interface ContainmentFacts {
  /**
   * sha256 (hex) of each host credential that must not be reachable inside the sandbox (the
   * helper's GitHub token). Only digests ever cross into the sandbox: the property probe hashes
   * what it can read there and compares.
   */
  credentialDigests?: readonly string[];
}

/** One finished file of a running slice, as the root-owned runner passed it on from the sandbox. */
export interface TesterProgress {
  /** The tree root the report's absolute file names are relative to (as in `TesterRun`). */
  rootDir: string;
  /** A vitest JSON report holding just that file (`{ testResults: [ … ] }`), parsed like the final report. */
  reportText: string;
  /** The slice's unhandled errors so far. */
  unhandledErrors: number;
}

export interface TesterRunSpec {
  /** The lane's own vitest configuration is used, as on a run machine. */
  lane: HelperLane;
  files: string[];
  /** Vitest workers: what the governor allows for a unit slice, always 1 for integration and end-to-end. */
  workers: number;
  signal: AbortSignal;
  /** Called once per finished file while the slice runs. */
  onProgress?: (p: TesterProgress) => void;
}

export type CheckResult = 'pass' | 'fail' | 'unrunnable';

export interface ContainmentCheck { name: string; result: CheckResult; detail?: string }

export interface ContainmentReport {
  ok: boolean;
  checks: ContainmentCheck[];
  /** First failing or unrunnable check, for the dashboard (`helper-containment-unproven`). */
  reason: string | null;
}

export interface TesterRun {
  /** The tree root the report's absolute file names are relative to. */
  rootDir: string;
  exitCode: number | null;
  /** The vitest JSON report text, read from the runner's result pipe (never from the overlay). */
  resultText: string | null;
  /** Set when the result passed the 4 MB cap: refused whole, never truncated. */
  oversize?: { bytesSeen: number };
  unhandledErrors: number;
  vitestStartMs: number | null;
}

export interface HelperSandboxDriver {
  readonly kind: SandboxKind;
  /** Create the sandbox with no host mounts, no forwards and a fixed size (B2.1, B2.2). */
  create(size: SandboxSize): Promise<void>;
  start(): Promise<{ startMs: number }>;
  stop(): Promise<void>;
  status(): Promise<SandboxStatus>;
  /**
   * Every start-up check, each a pass/fail fact; an unrunnable check is a fail (refuse): the B2
   * walls, the paired network test, and the sandbox property test (no host path readable and no
   * host credential reachable as `tester` or `builder`).
   */
  checks(facts?: ContainmentFacts): Promise<ContainmentReport>;
  /**
   * What makes this sandbox "the same image" (spec C item 3): the pinned base image's digest and a
   * hash of the sandbox settings. The daily re-creation from the same pinned image changes neither.
   * Null when the image is not pinned or cannot be named (a waiting change is then refused).
   */
  imageIdentity(size: SandboxSize): Promise<SandboxImageIdentity | null>;
  /**
   * Stream a tar of a tree's files into `/srv/trees/<treeId>` (the copy is the only way a tree
   * enters). A tar that carries a `node_modules` path is refused. With `placed`, the tree already
   * holds the packages `placePackages` put there and nothing else; without it the tree starts empty.
   */
  copyIn(treeId: string, tar: Readable, opts?: { placed?: boolean }): Promise<{ copyMs: number }>;
  /**
   * Whether the package volume holds the set for this install-inputs hash exactly as it was locked:
   * the manifest of file hashes is recomputed inside the sandbox and must equal `manifestDigest`.
   * Checked before each use. False for an absent set, any difference, or a volume that is not there.
   */
  verifyPackages(hash: string, manifestDigest: string): Promise<boolean>;
  /**
   * Whether the package volume (its own disk beside the sandbox image) is there and mounted. False
   * names the refusal `package-volume-missing`; nothing is installed or placed without it.
   */
  packageVolumeReady(): Promise<boolean>;
  /** Delete one package set from the volume (a failed check, or the cap). */
  discardPackages(hash: string): Promise<void>;
  /**
   * As `builder`, with the filtered network: `npm ci` in `mergedTreeId`, which the CALLER has
   * checked is a MERGED commit's tree (never a waiting change's). The result moves to the package
   * volume under `hash`, root-owned and read-only, with its manifest; `manifestDigest` is null when
   * the install failed. nice 19.
   */
  installPackages(hash: string, mergedTreeId: string, signal: AbortSignal): Promise<{ exitCode: number | null; manifestDigest: string | null }>;
  /**
   * Root starts `/srv/trees/<treeId>` empty and puts the locked packages of `hash` in it, BEFORE
   * any file of the tree is copied in. They stay root-owned and read-only through the build and
   * every slice.
   */
  placePackages(treeId: string, hash: string, manifestDigest: string): Promise<void>;
  /** As `builder`, no network, the packages read-only: the build. nice 19. */
  build(treeId: string, signal: AbortSignal): Promise<{ exitCode: number | null }>;
  /** Root makes the prepared tree read-only (`chown root`, `chmod a-w`). */
  sealTree(treeId: string): Promise<void>;
  /**
   * As `tester`, in a fresh overlay on the read-only tree, no network (its own loopback and one
   * dummy interface that reaches nothing): ONE vitest process on exactly these files, with the
   * lane's own configuration. Progress leaves through the root-owned runner on a pipe it opened.
   */
  execAsTester(treeId: string, run: TesterRunSpec): Promise<TesterRun>;
  /** Kill every builder/tester process; returns how many survived. */
  reap(): Promise<{ survivors: number }>;
  removeTree(treeId: string): Promise<void>;
  /** Free bytes inside the sandbox's tree volume; null unknown. */
  sandboxFreeBytes(): Promise<number | null>;
  /** Busy cores used by the sandbox itself (Windows: the helper scope's cpu.stat); null unknown. */
  sandboxBusyCores(): Promise<number | null>;
  /**
   * Delete the sandbox (VM or distro and its disk), keeping the installed tooling AND the package
   * volume, which is its own disk beside the sandbox image: a recreate is destroy + create.
   */
  destroy(): Promise<void>;
  /** Remove the sandbox completely, the package volume included (`instar helper uninstall`). */
  uninstall(): Promise<void>;
}

/**
 * Read at most `max` bytes from a stream. Past the cap the WHOLE result is refused (never cut):
 * `{ oversize: { bytesSeen } }`, and the stream is drained no further.
 */
export async function readCapped(stream: Readable, max: number = HELPER_LIMITS.resultMaxBytes): Promise<{ text: string } | { oversize: { bytesSeen: number } }> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    seen += b.length;
    if (seen > max) {
      stream.destroy();
      return { oversize: { bytesSeen: seen } };
    }
    chunks.push(b);
  }
  return { text: Buffer.concat(chunks).toString('utf-8') };
}

/** Framing of the in-sandbox runner's result on its own stdout (everything else goes to stderr). */
export const RESULT_BEGIN = 'INSTAR-HELPER-RESULT-BEGIN';
export const RESULT_END = 'INSTAR-HELPER-RESULT-END';

/** A progress line on the runner's stdout: this prefix, one space, then one JSON object. */
export const PROGRESS_PREFIX = 'INSTAR-HELPER-PROGRESS';

/** The runner's exit code when the package volume is not there (`package-volume-missing`). */
export const PKG_VOLUME_MISSING_EXIT = 44;

/**
 * Parse one progress line (`INSTAR-HELPER-PROGRESS {"unhandled":N,"file":{…}}`): the finished
 * file as a one-file vitest report, and the slice's unhandled-error count so far. Null for any
 * other line, a line over the bound, or a malformed one: a line that is not progress is ignored,
 * never guessed at.
 */
export function parseProgressLine(line: string): Omit<TesterProgress, 'rootDir'> | null {
  if (!line.startsWith(`${PROGRESS_PREFIX} `) || Buffer.byteLength(line) > HELPER_LIMITS.progressLineMaxBytes) return null;
  let o: unknown;
  try { o = JSON.parse(line.slice(PROGRESS_PREFIX.length + 1)); } catch { return null; } // @silent-fallback-ok: a broken progress line is dropped; the slice's last answer still carries every file
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const x = o as { unhandled?: unknown; file?: unknown };
  if (typeof x.unhandled !== 'number' || !Number.isSafeInteger(x.unhandled) || x.unhandled < 0) return null;
  const f = x.file as { name?: unknown; assertionResults?: unknown } | null;
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !Array.isArray(f.assertionResults)) return null;
  return { reportText: JSON.stringify({ testResults: [f] }), unhandledErrors: x.unhandled };
}

/** The lane's own vitest configuration, as the run machines use it (../inventory.ts LANES). */
export const LANE_VITEST_CONFIG: Readonly<Record<HelperLane, string>> = Object.freeze({
  unit: 'vitest.config.ts', integration: 'vitest.integration.config.ts', e2e: 'vitest.e2e.config.ts',
});

/** Pull the framed result out of the runner's stdout; null when the frame is missing or broken. */
export function unframeResult(stdout: string): { exitCode: number | null; unhandledErrors: number; vitestStartMs: number | null; report: string } | null {
  const b = stdout.indexOf(RESULT_BEGIN);
  const e = stdout.lastIndexOf(RESULT_END);
  if (b < 0 || e < b) return null;
  const header = stdout.slice(b + RESULT_BEGIN.length, stdout.indexOf('\n', b)).trim();
  const m = /^exit=(-?\d+|null) unhandled=(\d+) start_ms=(\d+|null)$/.exec(header);
  if (!m) return null;
  const body = stdout.slice(stdout.indexOf('\n', b) + 1, e);
  return {
    exitCode: m[1] === 'null' ? null : Number(m[1]),
    unhandledErrors: Number(m[2]),
    vitestStartMs: m[3] === 'null' ? null : Number(m[3]),
    report: body.trim(),
  };
}

/**
 * The sandbox property test's check names (spec "Tests", sandbox property). For each of the two
 * users that run code: no host path readable (the marker in the owner's home, any host-folder
 * mount, any host home folder); the helper's GitHub token not reachable; the agent's secret store
 * not reachable; no SSH-agent or keychain socket reachable. `control-channel-env-clean` is the
 * same credential test on what the host's control channel itself hands the sandbox.
 */
export const SANDBOX_PROPERTY_USERS: readonly string[] = Object.freeze(['tester', 'builder']);
export const SANDBOX_PROPERTY_FACETS: readonly string[] = Object.freeze(['no-host-path-readable', 'no-github-token', 'no-secret-store', 'no-agent-socket']);
export const SANDBOX_PROPERTY_CHECKS: readonly string[] = Object.freeze([
  ...SANDBOX_PROPERTY_USERS.flatMap((u) => SANDBOX_PROPERTY_FACETS.map((f) => `${u}-${f}`)),
  'control-channel-env-clean',
]);

/** The B2 checks every start must prove; any missing from a report counts as unrunnable. */
export const REQUIRED_CHECKS_COMMON: readonly string[] = Object.freeze([
  'config-no-mounts', 'config-no-forwards', 'proc-mounts-clean', 'owner-marker-invisible',
  'testns-no-route-host-loopback', 'testns-no-route-host-iface', 'testns-no-route-ipv6',
  'testns-own-loopback-works', 'probe-positive-controls',
  // B2 amended: the dummy interface, no default route, and the paired test on a local-network and a tailnet address.
  'testns-dummy-iface-present', 'testns-no-default-route', 'testns-no-route-lan', 'testns-no-route-tailnet-listener',
  // The sandbox property test (a condition of the approval): as tester and as builder, no host
  // path is readable and no host credential is reachable; and nothing of the kind rides the control channel.
  ...SANDBOX_PROPERTY_CHECKS,
  'builder-blocked-host', 'builder-registry-reachable', 'builder-drop-counter-rises', 'nft-table-hash',
  'testns-no-foreign-sockets', 'builder-view-no-foreign-sockets', 'vsock-refused',
  'forward-listener-testns-up', 'forward-listener-guest-up', 'no-forward-from-testns', 'no-forward-from-guest-user',
  'tester-no-sudo', 'builder-no-sudo', 'tester-tree-readonly', 'builder-tree-readonly', 'tester-nft-denied', 'builder-nft-denied',
]);
export const REQUIRED_CHECKS_WSL: readonly string[] = Object.freeze([
  ...REQUIRED_CHECKS_COMMON, 'testns-no-route-echo-distro', 'scope-limits', 'no-mnt-c', 'no-mnt-wsl', 'no-windows-interop', 'owner-signal-updates',
]);

/**
 * Parse the in-sandbox check script's output: one `CHECK <name> <pass|fail> [detail]` line per
 * check. A required check that is absent, or reported anything but pass/fail, is `unrunnable`,
 * and the report is ok only when every required check passed.
 */
export function parseContainmentOutput(text: string | null, required: readonly string[], extra: ContainmentCheck[] = []): ContainmentReport {
  const seen = new Map<string, ContainmentCheck>();
  for (const line of (text ?? '').split('\n')) {
    const m = /^CHECK\s+([a-z0-9-]+)\s+(pass|fail)(?:\s+(.*))?$/.exec(line.trim());
    if (m && !seen.has(m[1])) seen.set(m[1], { name: m[1], result: m[2] as 'pass' | 'fail', ...(m[3] ? { detail: m[3].slice(0, 300) } : {}) });
  }
  for (const c of extra) seen.set(c.name, c);
  const checks: ContainmentCheck[] = required.map((n) => seen.get(n) ?? { name: n, result: 'unrunnable', detail: 'not reported' });
  for (const [n, c] of seen) if (!required.includes(n)) checks.push(c);
  const bad = checks.find((c) => c.result !== 'pass');
  return { ok: !bad, checks, reason: bad ? `${bad.name}:${bad.result}${bad.detail ? `:${bad.detail}` : ''}` : null };
}

/**
 * Host-disk margin (B2): free space must cover the remaining growth of the sandbox disk AND of the
 * package volume (its own disk on the same host disk), plus 5 GB. A size that is not known counts
 * as nothing written yet (the whole cap may still grow). Without `pkg` only the sandbox disk is
 * counted (a driver with no package disk on the host).
 */
export function hostDiskOk(hostFreeBytes: number | null, diskGb: number, diskFileBytes: number | null, pkg?: { capBytes: number; fileBytes: number | null }): boolean {
  if (hostFreeBytes === null) return false;
  const cap = diskGb * 1024 ** 3;
  const growth = Math.max(0, cap - (diskFileBytes ?? 0));
  const pkgGrowth = pkg ? Math.max(0, pkg.capBytes - (pkg.fileBytes ?? 0)) : 0;
  return hostFreeBytes >= growth + pkgGrowth + HELPER_LIMITS.hostDiskMarginBytes;
}

/**
 * The paired network test (B2 amended): from inside a test namespace a connection to a listener
 * the helper service just opened on the host must FAIL, while the same listener answers a
 * connection made from the host side. A failed connection alone proves nothing; the pair proves
 * the wall. One check per address kind:
 *  - no address of that kind on this host: `unrunnable` (the helper does not run);
 *  - the host's own connection did not answer: `fail` (no positive control);
 *  - the in-sandbox script did not report its attempt: `unrunnable`;
 *  - the in-sandbox connection succeeded: `fail`; it failed: `pass`.
 */
export function pairedRouteChecks(scriptOutput: string, pairs: ReadonlyArray<{ name: string; kind: string; address: string | null; answeredFromHost: boolean }>): ContainmentCheck[] {
  return pairs.map((p): ContainmentCheck => {
    if (!p.address) return { name: p.name, result: 'unrunnable', detail: `no ${p.kind} address on this host` };
    if (!p.answeredFromHost) return { name: p.name, result: 'fail', detail: `the host listener on its ${p.kind} address did not answer from the host side (no positive control)` };
    const m = new RegExp(`^CHECK ${p.name} (pass|fail)(?:\\s+(.*))?$`, 'm').exec(scriptOutput);
    if (!m) return { name: p.name, result: 'unrunnable', detail: 'not reported from inside the test namespace' };
    return m[1] === 'pass' ? { name: p.name, result: 'pass' } : { name: p.name, result: 'fail', detail: `reachable from inside a test namespace${m[2] ? `: ${m[2].slice(0, 200)}` : ''}` };
  });
}

/**
 * The no-forwarding checks with their positive control: a probe passes only when the in-sandbox
 * listener reported itself up from its own side AND the host could not reach it.
 */
export function forwardProbeChecks(scriptOutput: string, reachable: { fromTestNs: boolean; fromGuest: boolean }): ContainmentCheck[] {
  const up = (name: string) => new RegExp(`^CHECK ${name} pass`, 'm').test(scriptOutput);
  const one = (name: string, listenerUp: boolean, reached: boolean): ContainmentCheck =>
    !listenerUp ? { name, result: 'fail', detail: 'the in-sandbox listener never came up (no positive control)' }
      : reached ? { name, result: 'fail', detail: 'reachable from the host 127.0.0.1' } : { name, result: 'pass' };
  return [
    one('no-forward-from-testns', up('forward-listener-testns-up'), reachable.fromTestNs),
    one('no-forward-from-guest-user', up('forward-listener-guest-up'), reachable.fromGuest),
  ];
}
