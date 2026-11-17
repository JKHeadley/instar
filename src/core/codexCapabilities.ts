/**
 * codexCapabilities — runtime feature detection for the Codex CLI.
 *
 * Codex's flag surface changes across versions, and instar agents run whatever
 * codex the operator has installed (0.130 → 0.133+ all observed). Rather than
 * track a version matrix, we probe the binary's `--help` once per binary path
 * and cache the answer. Builders gate version-specific flags on these probes so
 * an older codex never receives a flag it would reject (which would fail the
 * whole launch).
 */

import { execFileSync, spawn } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';

/** Memoized per binaryPath — `codex --help` is invoked at most once per path per process. */
const hookTrustBypassCache = new Map<string, boolean>();
const versionCache = new Map<string, { version: CodexCliVersion | null; checkedAt: number }>();

export interface CodexCliVersion { major: number; minor: number; patch: number }

/**
 * The earliest Codex CLI release that can run the newer GPT-6.x ids on a
 * ChatGPT account. Live-probed 2026-11-17 against the subscription:
 * 0.165.0, 0.160.0 and 0.156.1 refuse gpt-6.2-sol and gpt-6.2-astra with
 * "not supported when using Codex with a ChatGPT account"; 0.166.0, 0.168.0
 * and 0.169.0 answer both. gpt-6.1-sol has the same boundary (2026-11-04).
 */
export const CODEX_NEWER_MODELS_MIN_CLI: CodexCliVersion = { major: 0, minor: 166, patch: 0 };

/**
 * Newer codex ids that an older CLI refuses, each mapped to the nearest model
 * that CLI still runs (same size, previous generation). A launch on a CLI
 * below CODEX_NEWER_MODELS_MIN_CLI takes the mapped model instead of failing.
 */
export const CODEX_OLDER_CLI_FALLBACKS: Readonly<Record<string, string>> = {
  'gpt-6.1-sol': 'gpt-6-sol',
  'gpt-6.2-sol': 'gpt-6-sol',
  'gpt-6.2-astra': 'gpt-6-astra',
};

/**
 * How long a probe result is trusted: a read version 10 minutes (a CLI upgrade
 * is picked up within it), an unreadable one 60 s (one slow cold start must not
 * pin a current CLI to the older models for long).
 */
const VERSION_TTL_MS = 600_000;
const UNREADABLE_TTL_MS = 60_000;
const VERSION_PROBE_TIMEOUT_MS = 2000;
const inflight = new Map<string, Promise<CodexCliVersion | null>>();

function parseVersion(out: string): CodexCliVersion | null {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)/m.exec(out.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

/** The cached probe result, or undefined when there is none (or it expired). Never spawns. */
export function codexCliVersionCached(binaryPath: string): CodexCliVersion | null | undefined {
  if (!binaryPath) return null;
  const cached = versionCache.get(binaryPath);
  if (!cached) return undefined;
  const ttl = cached.version ? VERSION_TTL_MS : UNREADABLE_TTL_MS;
  return Date.now() - cached.checkedAt < ttl ? cached.version : undefined;
}

/**
 * Probe `codex --version` without blocking the event loop; concurrent callers
 * share one probe. The result (including "unreadable") is cached for 10 minutes.
 */
export function refreshCodexCliVersion(binaryPath: string): Promise<CodexCliVersion | null> {
  if (!binaryPath) return Promise.resolve(null);
  const running = inflight.get(binaryPath);
  if (running) return running;
  let settle!: (version: CodexCliVersion | null) => void;
  const probe = new Promise<CodexCliVersion | null>((resolve) => { settle = resolve; });
  // Registered before anything can settle, and removed only if it is still ours,
  // so a probe that settles synchronously can never leave a stale entry behind.
  inflight.set(binaryPath, probe);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const finish = (version: CodexCliVersion | null) => {
    if (settled) return;
    settled = true;
    if (deadline) clearTimeout(deadline);
    versionCache.set(binaryPath, { version, checkedAt: Date.now() });
    if (inflight.get(binaryPath) === probe) inflight.delete(binaryPath);
    settle(version);
  };
  let out = '';
  let child: ReturnType<typeof spawn>;
  try {
    // stdin closed so a binary that reads it cannot wait on us; SIGKILL on the
    // deadline because a wedged binary may ignore SIGTERM. The deadline settles
    // the probe even if the child never exits, so no caller waits longer than
    // VERSION_PROBE_TIMEOUT_MS. The promise never rejects.
    child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // @silent-fallback-ok: an unreadable CLI version is reported as null; each caller picks its own policy
    finish(null);
    return probe;
  }
  deadline = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* @silent-fallback-ok: the child is already gone */ }
    finish(null);
  }, VERSION_PROBE_TIMEOUT_MS);
  deadline.unref?.();
  child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString('utf-8'); });
  // @silent-fallback-ok: an unreadable CLI version is reported as null; each caller picks its own policy
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code === 0 ? parseVersion(out) : null));
  return probe;
}

/**
 * `codex --version` parsed; null when unreadable. Synchronous, for the one sync
 * caller that needs an answer (the topic resolver). A fresh cache entry is
 * returned as is; an expired one is returned too while a background probe
 * refreshes it. Only the very first read of a binary runs a bounded 2 s
 * synchronous probe (SIGKILL on the deadline), so a wedged binary can pause
 * this path at most once per process. Async callers use refreshCodexCliVersion.
 */
export function codexCliVersion(binaryPath: string): CodexCliVersion | null {
  if (!binaryPath) return null;
  const fresh = codexCliVersionCached(binaryPath);
  if (fresh !== undefined) return fresh;
  const stale = versionCache.get(binaryPath);
  if (stale) {
    void refreshCodexCliVersion(binaryPath);
    return stale.version;
  }
  let version: CodexCliVersion | null = null;
  try {
    const out = withSyncOp(() => execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8', timeout: VERSION_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    }));
    version = parseVersion(out);
  } catch { /* @silent-fallback-ok: an unreadable CLI version is reported as null; each caller picks its own policy */ }
  versionCache.set(binaryPath, { version, checkedAt: Date.now() });
  return version;
}

function atLeast(v: CodexCliVersion, min: CodexCliVersion): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/**
 * Whether this CLI can run the newer GPT-6.x ids (gpt-6.1-sol, gpt-6.2-sol,
 * gpt-6.2-astra). Fails closed: an unreadable version answers false, so a
 * session launch takes the known-working older model.
 */
export function codexSupportsNewerModels(binaryPath: string): boolean {
  const v = codexCliVersion(binaryPath);
  return v !== null && atLeast(v, CODEX_NEWER_MODELS_MIN_CLI);
}

/** Kept for existing callers; same gate as codexSupportsNewerModels. */
export const codexSupportsGpt61Sol = codexSupportsNewerModels;

function pick(model: string, fallback: string, ok: boolean | null, unknownVersion: 'fallback' | 'keep'): string {
  if (ok === true) return model;
  if (ok === null && unknownVersion === 'keep') return model;
  return fallback;
}

/**
 * The model to launch on this CLI. Returns `model` unchanged unless it is a
 * newer id the CLI cannot run, in which case the older-CLI fallback is
 * returned.
 *
 * `unknownVersion` decides an unreadable version: 'fallback' (session
 * launches, which have no retry) or 'keep' (one-shot calls, which already
 * retry a refused model on CODEX_CHATGPT_FALLBACK_MODEL).
 *
 * Synchronous and NEVER spawns: it reads the cached probe. On a miss it starts
 * a background probe and treats the version as unknown for this call. Async
 * callers should use codexModelForCliAsync, which waits for the probe.
 */
export function codexModelForCli(
  model: string,
  binaryPath: string,
  unknownVersion: 'fallback' | 'keep',
  supported?: (binaryPath: string) => boolean | null,
): string {
  const fallback = CODEX_OLDER_CLI_FALLBACKS[model];
  if (!fallback) return model;
  if (supported) return pick(model, fallback, supported(binaryPath), unknownVersion);
  const v = codexCliVersionCached(binaryPath);
  if (v === undefined) void refreshCodexCliVersion(binaryPath);
  return pick(model, fallback, v == null ? null : atLeast(v, CODEX_NEWER_MODELS_MIN_CLI), unknownVersion);
}

/** As codexModelForCli, but waits (without blocking the event loop) for the version probe. */
export async function codexModelForCliAsync(
  model: string,
  binaryPath: string,
  unknownVersion: 'fallback' | 'keep',
): Promise<string> {
  const fallback = CODEX_OLDER_CLI_FALLBACKS[model];
  if (!fallback) return model;
  const cached = codexCliVersionCached(binaryPath);
  const v = cached !== undefined ? cached : await refreshCodexCliVersion(binaryPath);
  return pick(model, fallback, v === null ? null : atLeast(v, CODEX_NEWER_MODELS_MIN_CLI), unknownVersion);
}

/**
 * Whether `<binaryPath>` accepts `--dangerously-bypass-hook-trust`.
 *
 * The flag was added in codex 0.133 ("Run enabled hooks without requiring
 * persisted hook trust for this invocation") and is ABSENT in 0.131/0.130.
 * instar launches codex with this flag so its OWN safety hooks
 * (installCodexHooks) run automatically with no interactive "trust these hooks?"
 * prompt — which would otherwise freeze an unattended/autonomous session. It is
 * safe-by-construction here: instar both writes the hooks and owns the launch
 * command, so there is no untrusted third-party hook to guard against, and the
 * agent cannot strip a flag from a launch it doesn't construct.
 *
 * Fails closed: any probe error (missing binary, timeout, non-zero exit) returns
 * false, so an undetectable/older codex simply omits the flag. The hooks still
 * block dangerous actions in that case — they just sit behind codex's interactive
 * trust prompt rather than running unprompted.
 */
export function codexSupportsHookTrustBypass(binaryPath: string): boolean {
  if (!binaryPath) return false;
  const cached = hookTrustBypassCache.get(binaryPath);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const help = execFileSync(binaryPath, ['--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    supported = help.includes('--dangerously-bypass-hook-trust');
  } catch {
    supported = false;
  }
  hookTrustBypassCache.set(binaryPath, supported);
  return supported;
}

/** Test-only: clear the memoization cache so a probe re-runs. */
export function __resetCodexCapabilityCache(): void {
  hookTrustBypassCache.clear();
  versionCache.clear();
  inflight.clear();
}
