/**
 * Production wiring for the GeminiLoopDriver (need-gem-002, increment 2).
 *
 * Turns the injected-dependency engine (`GeminiLoopDriver`) into real
 * subscription-auth gemini spawns:
 *   - `createGeminiLoopSpawn`     — routes every turn through the gemini transport
 *                                   (`spawnGeminiAndWait` + `buildGeminiChildEnv`,
 *                                   which strips every billing env var → subscription
 *                                   OAuth is the only possible auth path).
 *   - `parseLatestGeminiSessionHandle` — pure parser of `gemini --list-sessions`
 *                                   output → the FRESHEST session's UUID (the one
 *                                   turn 1 just created). Min-age, not list order.
 *   - `createGeminiHandleCapture` — runs `--list-sessions` via the transport and
 *                                   parses it; returns null if no handle resolves
 *                                   (the engine then ABORTS rather than guessing).
 *   - `createQuotaBudgetGate`     — wraps the existing QuotaTracker so a loop refuses
 *                                   to start / continue under load or spend pressure.
 *
 * Spec: docs/specs/gemini-multi-turn-loop-driver.md
 */

import {
  buildGeminiChildEnv,
  spawnGeminiAndWait,
} from '../providers/adapters/gemini-cli/transport/geminiSpawn.js';
import type {
  GeminiLoopSpawn,
  GeminiLoopHandleCapture,
  GeminiLoopBudgetGate,
} from './GeminiLoopDriver.js';

/** Default per-turn spawn timeout (a single gemini turn). */
export const DEFAULT_GEMINI_TURN_TIMEOUT_MS = 180_000;

/**
 * Parse `gemini --list-sessions` stdout and return the FRESHEST session's UUID.
 *
 * Each session row looks like:
 *   `  3. Remember the codeword... (Just now) [ef951c6e-49b4-49df-a8f0-b8aa62b4403f]`
 * The age is the parenthesised group immediately before the `[uuid]` bracket
 * (anchored there so parentheses inside the title don't interfere). We pick the
 * MINIMUM age rather than trusting list order, so the handle is the session turn 1
 * just created. Returns null when no row parses.
 */
export function parseLatestGeminiSessionHandle(stdout: string): string | null {
  const rowRe = /\(([^()]+)\)\s*\[([0-9a-fA-F-]{36})\]/g;
  let best: { uuid: string; ageSec: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(stdout)) !== null) {
    const ageSec = parseRelativeAgeSeconds(m[1]);
    const uuid = m[2].toLowerCase();
    if (!best || ageSec < best.ageSec) {
      best = { uuid, ageSec };
    }
  }
  return best ? best.uuid : null;
}

/** Parse a gemini relative-age string ("Just now", "16 minutes ago") to seconds. */
function parseRelativeAgeSeconds(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (/just now/.test(s)) return 0;
  const num = s.match(/(\d+)/);
  const n = num ? parseInt(num[1], 10) : NaN;
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  if (/second/.test(s)) return n;
  if (/minute/.test(s)) return n * 60;
  if (/hour/.test(s)) return n * 3_600;
  if (/day/.test(s)) return n * 86_400;
  if (/week/.test(s)) return n * 604_800;
  if (/month/.test(s)) return n * 2_592_000;
  return Number.POSITIVE_INFINITY;
}

/**
 * Production gemini spawn — every turn routes through the subscription-auth
 * transport. `buildGeminiChildEnv()` strips all billing env vars, so no argv this
 * receives can introduce an API key.
 */
export function createGeminiLoopSpawn(
  geminiPath: string,
  turnTimeoutMs: number = DEFAULT_GEMINI_TURN_TIMEOUT_MS,
): GeminiLoopSpawn {
  return async (argv) => {
    const r = await spawnGeminiAndWait(geminiPath, argv, {
      timeoutMs: turnTimeoutMs,
      env: buildGeminiChildEnv(),
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated };
  };
}

/**
 * Production handle capture — after turn 1, list sessions and pick the freshest.
 * Single-concurrency (`maxConcurrent: 1`) keeps this unambiguous: turn 1 just ran,
 * so its session is the "Just now" / min-age row even if other gemini one-shots
 * (e.g. cross-model review) created older sessions in the shared cwd.
 */
export function createGeminiHandleCapture(
  geminiPath: string,
  listTimeoutMs: number = 30_000,
): GeminiLoopHandleCapture {
  return async () => {
    try {
      const r = await spawnGeminiAndWait(geminiPath, ['--list-sessions'], {
        timeoutMs: listTimeoutMs,
        env: buildGeminiChildEnv(),
      });
      if (r.exitCode !== 0) return null;
      return parseLatestGeminiSessionHandle(r.stdout);
    } catch {
      // @silent-fallback-ok — intentional fail-closed: if `--list-sessions` errors
      // we return null, and the GeminiLoopDriver ABORTS the run (stopReason
      // 'handle-capture-failure') rather than guessing a handle. Not a degraded
      // silent continue — it is the safe stop, surfaced in the run's stopReason.
      return null;
    }
  };
}

/** Minimal slice of QuotaTracker the budget gate needs. */
export interface SpawnAdmissionSource {
  shouldSpawnSession(): { allowed: boolean; reason: string };
}

/**
 * Production budget gate — reuses the existing QuotaTracker spawn-admission
 * decision (the same daily-spend / load-shedding signal every other instar spawn
 * respects). Fails OPEN if no tracker is wired (the engine's own maxTurns +
 * spawn-failure handling still bound the loop).
 */
export function createQuotaBudgetGate(
  quota: SpawnAdmissionSource | null | undefined,
): GeminiLoopBudgetGate {
  return () => {
    if (!quota) return { ok: true };
    const v = quota.shouldSpawnSession();
    return { ok: v.allowed, reason: v.allowed ? undefined : v.reason };
  };
}
