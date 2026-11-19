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
import { HELPER_LIMITS } from './helperProtocol.js';

export type SandboxKind = 'lima' | 'wsl' | 'fake' | 'test-bypass';

export interface SandboxStatus {
  exists: boolean;
  running: boolean;
  /** Current size of the sandbox's disk file on the host, bytes; null unknown. */
  diskFileBytes: number | null;
  /** Peak host memory the sandbox used, MB; null unknown. */
  peakMemMb: number | null;
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
  /** Every B2 check, each a pass/fail fact; an unrunnable check is a fail (refuse). */
  checks(): Promise<ContainmentReport>;
  /** Stream a `git archive` tar into `/srv/trees/<treeId>` (the copy is the only way a tree enters). */
  copyIn(treeId: string, tar: Readable): Promise<{ copyMs: number }>;
  /** As `builder`: `npm-ci` (filtered network, private mount view) or `build` (no network). nice 19. */
  execAsBuilder(treeId: string, step: 'npm-ci' | 'build', signal: AbortSignal): Promise<{ exitCode: number | null }>;
  /** Root makes the prepared tree read-only (`chown root`, `chmod a-w`). */
  sealTree(treeId: string): Promise<void>;
  /** As `tester`, in a fresh overlay on the read-only tree, no network: vitest on exactly these files. */
  execAsTester(treeId: string, run: { files: string[]; workers: number; signal: AbortSignal }): Promise<TesterRun>;
  /** Kill every builder/tester process; returns how many survived. */
  reap(): Promise<{ survivors: number }>;
  removeTree(treeId: string): Promise<void>;
  /** Free bytes inside the sandbox's tree volume; null unknown. */
  sandboxFreeBytes(): Promise<number | null>;
  /** Busy cores used by the sandbox itself (Windows: the helper scope's cpu.stat); null unknown. */
  sandboxBusyCores(): Promise<number | null>;
  /** Delete the sandbox (VM or distro and its disk), keeping the installed tooling: a recreate is destroy + create. */
  destroy(): Promise<void>;
  /** Remove the sandbox completely (`instar helper uninstall`). */
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

/** The B2 checks every start must prove; any missing from a report counts as unrunnable. */
export const REQUIRED_CHECKS_COMMON: readonly string[] = Object.freeze([
  'config-no-mounts', 'config-no-forwards', 'proc-mounts-clean', 'owner-marker-invisible',
  'testns-no-route-host-loopback', 'testns-no-route-host-iface', 'testns-no-route-lan', 'testns-no-route-tailnet', 'testns-no-route-ipv6',
  'testns-own-loopback-works', 'probe-positive-controls',
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

/** Host-disk margin (B2): free space must cover the sandbox disk's remaining growth plus 5 GB. */
export function hostDiskOk(hostFreeBytes: number | null, diskGb: number, diskFileBytes: number | null): boolean {
  if (hostFreeBytes === null) return false;
  const cap = diskGb * 1024 ** 3;
  const growth = Math.max(0, cap - (diskFileBytes ?? 0));
  return hostFreeBytes >= growth + HELPER_LIMITS.hostDiskMarginBytes;
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
