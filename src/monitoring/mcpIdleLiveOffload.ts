/**
 * Idle-live MCP offload (dynamic-MCP-lifecycle lever 2) — pure eligibility logic.
 *
 * Today the McpProcessReaper NEVER touches a proc under a live/tracked session
 * (`session-live` → keep): a long autonomous session legitimately owns old MCP
 * servers. But a HEAVY MCP server (Playwright's Chromium, an Electron bridge) that
 * has been idle under a live session is exactly the steady-state footprint that
 * preceded the 2026-06-26 resource panic — Claude transparently re-spawns it on the
 * next tool call, so reclaiming an idle one loses nothing.
 *
 * This module is the PURE, fail-closed core of that decision. It NEVER kills; it
 * only decides eligibility from injected signals. The load-bearing safety is that
 * a session which is — or might be — actively using its tools is ALWAYS kept:
 * uncertainty (a null mid-tool-use signal) resolves to KEEP, never offload. The
 * stateful idle-clock + the actual reap wiring live in the reaper (dark + dry-run);
 * this keeps the risky decision boundary fully unit-testable in isolation.
 */

import type { McpProcessSignature } from './mcpProcessSignatures.js';

/**
 * Which MCP signatures are HEAVY enough to be worth offloading. A light stdio
 * bridge (instar/threadline) is cheap + keep-warm; only the process-heavy ones
 * (a browser engine, an Electron app) are offload candidates. Conservative: an
 * unlisted signature is treated as NOT heavy (kept).
 */
export const HEAVY_MCP_SIGNATURE_IDS: ReadonlySet<McpProcessSignature['id']> = new Set([
  'playwright-mcp', // spawns a full Chromium
]);

export function isHeavyMcpSignature(id: McpProcessSignature['id']): boolean {
  return HEAVY_MCP_SIGNATURE_IDS.has(id);
}

export interface IdleLiveOffloadConfig {
  /** Master switch — DARK by default. Off ⇒ never eligible (today's behavior). */
  enabled: boolean;
  /** Idle dwell before a heavy live-session MCP proc becomes offload-eligible. */
  idleOffloadMs: number;
}

export const DEFAULT_IDLE_LIVE_OFFLOAD_CONFIG: IdleLiveOffloadConfig = {
  enabled: false,
  idleOffloadMs: 30 * 60 * 1000, // ~30min — Justin's default (config-tunable)
};

/** The per-proc inputs to the eligibility decision (all injected / observed). */
export interface IdleLiveOffloadInput {
  signatureId: McpProcessSignature['id'];
  /** Whether the owning session is currently live/tracked. */
  ownerLive: boolean;
  /**
   * Whether the owning session is CURRENTLY mid-tool-use:
   *   true  = actively using its tools NOW → never offload,
   *   false = not mid-tool-use right now,
   *   null  = UNKNOWN (couldn't read the live frame) → fail-closed KEEP.
   */
  midToolUse: boolean | null;
  /** How long this proc has been continuously NOT-mid-tool-use (the idle clock),
   *  in ms, as tracked by the reaper across sweeps. 0 if the clock isn't running. */
  continuousIdleMs: number;
  /** Owner pinned to the keep-warm allowlist (never offload, e.g. Playwright if
   *  the operator chose to keep it warm everywhere). */
  keepWarm: boolean;
}

export type IdleLiveOffloadDecision =
  | { eligible: false; reason: string }
  | { eligible: true; reason: 'idle-live-offload' };

/**
 * Decide whether a heavy, idle, live-session MCP proc is offload-eligible.
 * FAIL-CLOSED at every step — any reason to doubt ⇒ keep. Only returns eligible
 * when: feature on, signature heavy, owner live, NOT keep-warm-pinned, the
 * mid-tool-use signal is a definite `false`, AND the continuous-idle clock has
 * crossed the threshold.
 */
export function decideIdleLiveOffload(
  input: IdleLiveOffloadInput,
  cfg: IdleLiveOffloadConfig,
): IdleLiveOffloadDecision {
  if (!cfg.enabled) return { eligible: false, reason: 'disabled' };
  if (!input.ownerLive) return { eligible: false, reason: 'owner-not-live' }; // the dead/orphan path is the existing reaper's job
  if (!isHeavyMcpSignature(input.signatureId)) return { eligible: false, reason: 'not-heavy' };
  if (input.keepWarm) return { eligible: false, reason: 'keep-warm' };
  if (input.midToolUse !== false) {
    // true = actively using tools; null = unknown. BOTH keep — fail-closed.
    return { eligible: false, reason: input.midToolUse === true ? 'mid-tool-use' : 'mid-tool-use-unknown' };
  }
  if (input.continuousIdleMs < cfg.idleOffloadMs) {
    return { eligible: false, reason: 'idle-window-not-reached' };
  }
  return { eligible: true, reason: 'idle-live-offload' };
}
