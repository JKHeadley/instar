/**
 * Capability declaration for the grok-build adapter (spec §4).
 *
 * Per the honest-declaration contract (the parity harness's stub-vs-real
 * check), this declares ONLY the primitives the factory actually wires.
 *
 * SHIPPED (probed against grok 1.0.4, 2026-08-14 — spec §0):
 *   - OneShotCompletion : `grok --prompt-file … --output-format json`
 *                         spawn-and-parse; usage + plan-rate cost come back
 *                         in the JSON envelope (spec §6.0).
 *   - SessionId         : binds SessionHandles to grok session ids (the
 *                         `sessionId` field of the one-shot envelope /
 *                         `~/.grok/sessions` entries).
 *   - HardKill          : SIGTERM→SIGKILL on the spawned pid.
 *
 * NOT declared (deliberate — spec §4.2, review-1 finding 10):
 *   - AgenticSessionRpc: grok's ACP (`grok agent stdio`) exists, but its
 *     permission/cancellation/resume contracts are UNVERIFIED. Wiring it
 *     half-probed would overclaim (the gemini Step-2 lesson; pi wired RPC
 *     only after a hands-on eval). Interactive grok sessions run through the
 *     SessionManager tmux path like every framework; the RPC face lands
 *     after a real probe of session-id equality, resume semantics, and
 *     permission default-deny.
 *   - HookEventReceiver / CompactionLifecycle: uncharacterized.
 */

import { CapabilityFlag, capabilitySet } from '../../capabilities.js';

export const grokBuildCapabilities = capabilitySet([
  // ── TRANSPORT ────────────────────────────────────────────────────────
  CapabilityFlag.OneShotCompletion,

  // ── OBSERVABILITY ────────────────────────────────────────────────────
  CapabilityFlag.SessionId,

  // ── CONTROL ──────────────────────────────────────────────────────────
  CapabilityFlag.HardKill,
]);
