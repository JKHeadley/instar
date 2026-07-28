/**
 * Capability declaration for the pi-cli adapter
 * (PI-HARNESS-INTEGRATION-SPEC §4.2).
 *
 * Per the honest-declaration contract (the parity harness's stub-vs-real
 * check — the rule the openai-codex and gemini-cli adapters follow), this
 * declares ONLY the primitives the factory actually wires. Declared-but-
 * stubbed is a capability-declaration lie.
 *
 * SHIPPED (every fact eval-verified against pi 0.78.1 — see
 * docs/specs/_drafts/pi-eval-report.md):
 *   - OneShotCompletion  : `pi -p --mode json` spawn-and-parse (usage + cost
 *                          come back on message_end — richer than gemini's).
 *   - AgenticSessionRpc  : pi's NATIVE `--mode rpc` stdio JSONL channel —
 *                          prompt / mid-stream steer / abort / resume. This
 *                          is the adapter's differentiator: the first
 *                          framework with a structured control channel
 *                          instead of a scraped TUI.
 *   - SessionId          : binds SessionHandles to pi session UUIDs.
 *   - HardKill           : SIGTERM→SIGKILL on the spawned pid.
 *
 * NOT declared (deliberate):
 *   - AgenticSessionInteractive: interactive pi sessions are launched through
 *     the SessionManager tmux path (frameworkSessionLaunch piCliBuilder),
 *     not through the provider registry — same split every framework has.
 *   - HookEventReceiver / CompactionLifecycle: pi has extension hooks and
 *     `compact`, but their live return-contracts are uncharacterized; wiring
 *     them half-probed would overclaim (the gemini Step-2 lesson).
 */

import { CapabilityFlag, capabilitySet } from '../../capabilities.js';

export const piCliCapabilities = capabilitySet([
  // ── TRANSPORT ────────────────────────────────────────────────────────
  CapabilityFlag.OneShotCompletion,
  CapabilityFlag.AgenticSessionRpc,

  // ── OBSERVABILITY ────────────────────────────────────────────────────
  CapabilityFlag.SessionId,

  // ── CONTROL ──────────────────────────────────────────────────────────
  CapabilityFlag.HardKill,
]);
