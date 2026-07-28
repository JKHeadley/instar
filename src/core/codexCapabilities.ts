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

/** Memoized per binaryPath — `codex --help` is invoked at most once per path per process. */
const hookTrustBypassCache = new Map<string, boolean>();

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
}
