/**
 * Capability declaration for the gemini-cli adapter (MINIMAL BODY).
 *
 * Apprenticeship Step 2 ships the MANDATORY floor only. Per the honest-
 * declaration contract (the parity harness's stub-vs-real check — the same
 * rule openai-codex/capabilities.ts follows), this declares ONLY the
 * primitives the factory actually wires. Declared-but-stubbed is a
 * capability-declaration lie.
 *
 * MANDATORY (shipped — §3.7):
 *   - OneShotCompletion : the transport / alive proof.
 *   - SessionId         : bind a SessionHandle to a gemini session UUID.
 *   - HardKill          : SIGTERM→SIGKILL on the spawn pid.
 *
 * CONDITIONAL (NOT declared — deferred to a later step, tracked as
 * `programNeeds` need-gem-001; see the spec §3.7):
 *   - HookEventReceiver    : native `gemini hooks` return-contract UNKNOWN
 *                            until live probing.
 *   - CompactionLifecycle  : native pre-compact vs synthesis UNKNOWN.
 *   - SessionResumeIndex   : `--list-sessions`/`--resume` verbs are known, but
 *                            the FULL session-layout parsing is deferred.
 *
 * Everything not in this set is honestly reported as unavailable on the
 * Gemini adapter by the registry — the parity harness then truthfully shows
 * the gap rather than the registry lying.
 */

import { CapabilityFlag, capabilitySet } from '../../capabilities.js';

export const geminiCliCapabilities = capabilitySet([
  // ── TRANSPORT ────────────────────────────────────────────────────────
  CapabilityFlag.OneShotCompletion,

  // ── OBSERVABILITY ────────────────────────────────────────────────────
  CapabilityFlag.SessionId,

  // ── CONTROL ──────────────────────────────────────────────────────────
  CapabilityFlag.HardKill,

  // NOT declared (CONDITIONAL — live contract not characterized in Step 2):
  //   HookEventReceiver, CompactionLifecycle, SessionResumeIndex
]);
