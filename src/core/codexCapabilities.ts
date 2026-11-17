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

import { execFileSync } from 'node:child_process';
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
 * `codex --version` parsed; null when unreadable. A read version is cached per
 * binary for 10 minutes (a CLI upgrade is picked up within that window), an
 * unreadable one for 60 s. The probe is synchronous, so its timeout is short:
 * a wedged binary costs at most 3 s, once per cache window.
 */
export function codexCliVersion(binaryPath: string): CodexCliVersion | null {
  if (!binaryPath) return null;
  const cached = versionCache.get(binaryPath);
  if (cached && Date.now() - cached.checkedAt < (cached.version ? 600_000 : 60_000)) return cached.version;
  let version: CodexCliVersion | null = null;
  try {
    const out = withSyncOp(() => execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const match = /^codex-cli (\d+)\.(\d+)\.(\d+)/m.exec(out.trim());
    if (match) version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
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

/**
 * The model to launch on this CLI. Returns `model` unchanged unless it is a
 * newer id the CLI cannot run, in which case the older-CLI fallback is
 * returned.
 *
 * `unknownVersion` decides an unreadable version: 'fallback' (session
 * launches, which have no retry) or 'keep' (one-shot calls, which already
 * retry a refused model on CODEX_CHATGPT_FALLBACK_MODEL).
 */
export function codexModelForCli(
  model: string,
  binaryPath: string,
  unknownVersion: 'fallback' | 'keep',
  supported?: (binaryPath: string) => boolean | null,
): string {
  const fallback = CODEX_OLDER_CLI_FALLBACKS[model];
  if (!fallback) return model;
  let ok: boolean | null;
  if (supported) ok = supported(binaryPath);
  else {
    const v = codexCliVersion(binaryPath);
    ok = v === null ? null : atLeast(v, CODEX_NEWER_MODELS_MIN_CLI);
  }
  if (ok === true) return model;
  if (ok === null && unknownVersion === 'keep') return model;
  return fallback;
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
}
