/**
 * Resolve the `gh` binary by absolute path instead of trusting the inherited PATH.
 *
 * WHY THIS EXISTS (found 2026-07-25 closing Tier 1 of convergence-towards-coherence):
 * the server is started by launchd, which supplies a minimal PATH that does NOT
 * include `/opt/homebrew/bin`. Every in-process `execFileSync('gh', …)` therefore
 * died with a raw `spawnSync gh ENOENT`. The visible consequence was that
 * `building → merged` on a project item could never succeed on this install — the
 * stage gate correctly refuses to take the caller's word and verifies the PR with
 * `gh`, so a missing binary read as "cannot verify" and the item stayed open.
 *
 * That is the second time this exact transition has been unreachable: see the
 * #866 note at the `ghPrView` callsite in routes.ts (2026-06-06), where the
 * helper was simply not injected. Same symptom, different cause, so the fix here
 * is deliberately about RESOLUTION rather than about that one callsite.
 *
 * Mirrors the established in-repo pattern (`BitwardenProvider.findBw`), minus its
 * `which` fallback: explicit override → cached → common absolute install locations.
 * No subprocess is spawned at all — resolution is pure filesystem existence checks,
 * so this cannot block the event loop and needs no sync-op funnel. A gh installed
 * somewhere unusual is served by INSTAR_GH_PATH, which the failure message names.
 *
 * Signal, not authority: this resolves a path or returns null. It makes no
 * decision about whether an operation may proceed — callers keep that judgement,
 * and a null result must surface as a NAMED diagnostic rather than as a silent
 * skip or a fabricated pass.
 */
import fs from 'node:fs';

/** Common absolute locations, in preference order. */
const CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const;

let cached: string | null = null;
let probed = false;

/**
 * @returns the absolute path to `gh`, or null when it genuinely cannot be found.
 *   Never throws — callers decide what a missing binary means for them.
 */
export function resolveGhBinary(): string | null {
  const override = process.env.INSTAR_GH_PATH;
  if (override && fs.existsSync(override)) return override;

  if (probed) return cached;
  probed = true;

  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  cached = null;
  return null;
}

/** Test seam: forget the cached probe so a test can vary the filesystem. */
export function __resetGhBinaryCacheForTests(): void {
  cached = null;
  probed = false;
}
