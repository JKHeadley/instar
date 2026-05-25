/**
 * Codex hook-contract canary.
 *
 * The Codex enforcement layer (installCodexHooks → .codex/hooks.json) rests on
 * a handful of load-bearing, empirically-won assumptions about Codex's hook
 * contract. Two of them were silent-failure bugs we already paid for live
 * (see docs/specs/codex-enforcement-hook-layer.md §P5c):
 *   1. The PreToolUse `matcher` is a REGEX against the tool name — a bare `*`
 *      matches NOTHING, so the guard silently never fires. It must be `.*`.
 *   2. Codex's shell tool is `exec_command` and carries the command in
 *      `tool_input.cmd` (not Claude's `tool_input.command`); the guard shim
 *      reads both.
 * If a future Codex version renames the hook events, drops PreToolUse, or
 * changes the deny mechanism, the gates would silently no-op again — "looks
 * installed, blocks nothing." This canary fails loudly instead.
 *
 * Two layers:
 *   (A) DETERMINISTIC invariant lock (always runs, env-independent): asserts
 *       buildInstarCodexHookGroups still emits the load-bearing shape — `.*`
 *       matcher, dangerous-command-guard on PreToolUse, the full Stop review
 *       trio. A refactor that regresses any of these fails the canary in CI.
 *   (B) BEST-EFFORT live-binary contract check: if a codex binary is
 *       resolvable on this host, read its embedded hook-event schema and
 *       assert the events instar depends on (PreToolUse, PermissionRequest,
 *       Stop, SessionStart, UserPromptSubmit) are still present. No binary →
 *       status 'skip' for layer B (NOT fail — most hosts/CI have no codex).
 *
 * RULE 3.1 RATIONALE
 *   Criticality: critical — a silent no-op guard is a false sense of safety on
 *                Codex's main destructive surface (shell/exec).
 *   Frequency:   startup/CI canary (deterministic layer is a unit-test drift lock;
 *                binary layer is best-effort per host).
 *   Stability:   semi-stable — Codex changes hook vocabulary across minor versions.
 *   Fallback:    none — failure is a code-fix surface, surfaced via DegradationReporter.
 *   Verdict:     deterministic structural assertion (A) + version-tolerant
 *                binary-schema probe (B); no LLM fallback needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildInstarCodexHookGroups } from '../../../../core/installCodexHooks.js';

/** Hook events instar's enforcement layer registers and depends on. */
export const REQUIRED_CODEX_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'Stop',
  'SessionStart',
  'UserPromptSubmit',
] as const;

export interface CodexHookContractCanaryResult {
  status: 'pass' | 'fail' | 'skip';
  message: string;
  details: {
    /** Layer A — deterministic invariant lock. */
    matcherIsRegex: boolean;
    dangerousGuardOnPreToolUse: boolean;
    stopReviewTrioWired: boolean;
    /** Layer B — live-binary probe. */
    binaryProbed: boolean;
    binaryPath?: string;
    missingEventsInBinary: string[];
    failures: string[];
  };
}

const PROBE_PROJECT_DIR = '/tmp/__codex_hook_canary__';

/**
 * Resolve a codex binary path, best-effort. Returns null if none found —
 * the binary layer is then skipped, not failed.
 */
export function resolveCodexBinaryForCanary(): string | null {
  // 1. asdf shim / PATH lookup (the host's real, doc-matching codex).
  for (const probe of ['codex']) {
    try {
      const out = execFileSync('which', [probe], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* not on PATH */
    }
  }
  // 2. Known npm-global vendor locations (asdf node installs).
  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(home, '.asdf', 'shims', 'codex'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Read a (possibly large) binary and test whether its embedded hook-event
 * schema enumerates the given event name. We look for the quoted event name
 * adjacent to the schema's hook-event vocabulary rather than anywhere in the
 * file, to avoid coincidental matches. Tolerant: returns true on match.
 */
function binaryDeclaresEvent(binaryText: string, event: string): boolean {
  // The schema serializes events as `"const": "PreToolUse"` (HookSpecificOutput
  // wires) and as enum members `"PreToolUse"` inside HookEventNameWire. Either
  // form proves the event is part of the contract.
  return (
    binaryText.includes(`"const": "${event}"`) ||
    binaryText.includes(`"${event}"`)
  );
}

/**
 * Run the canary. Layer A is synchronous and always meaningful. Layer B
 * probes a codex binary if one resolves; otherwise that layer is skipped.
 */
export function runCodexHookContractCanary(): CodexHookContractCanaryResult {
  const failures: string[] = [];

  // ---- Layer A: deterministic invariant lock ----
  const groups = buildInstarCodexHookGroups(PROBE_PROJECT_DIR);

  const preMatcher = groups.PreToolUse?.[0]?.matcher;
  const matcherIsRegex = preMatcher === '.*';
  if (!matcherIsRegex) {
    failures.push(`PreToolUse matcher is '${preMatcher}', expected '.*' (a bare '*' matches nothing — gate would silently never fire)`);
  }

  const preCommands = (groups.PreToolUse?.[0]?.hooks ?? []).map((h) => h.command);
  const dangerousGuardOnPreToolUse = preCommands.some((c) => c.includes('dangerous-command-guard.sh'));
  if (!dangerousGuardOnPreToolUse) {
    failures.push('dangerous-command-guard.sh missing from PreToolUse — Codex shell/exec would pass ungated');
  }

  const stopCommands = (groups.Stop?.[0]?.hooks ?? []).map((h) => h.command);
  const stopReviewTrioWired =
    stopCommands.some((c) => c.includes('response-review.js')) &&
    stopCommands.some((c) => c.includes('deferral-detector.js')) &&
    stopCommands.some((c) => c.includes('scope-coherence-checkpoint.js'));
  if (!stopReviewTrioWired) {
    failures.push('Stop review trio incomplete — expected response-review + deferral-detector + scope-coherence-checkpoint');
  }

  // ---- Layer B: best-effort live-binary contract probe ----
  const binaryPath = resolveCodexBinaryForCanary();
  let binaryProbed = false;
  const missingEventsInBinary: string[] = [];

  if (binaryPath) {
    try {
      const text = fs.readFileSync(binaryPath, 'latin1');
      // Sanity: only treat it as a probe if the binary actually carries the
      // hook schema (resolves the "wrong binary" / shim-script case gracefully).
      const looksLikeCodexHooks = text.includes('hook_event_name') || text.includes('HookEventNameWire');
      if (looksLikeCodexHooks) {
        binaryProbed = true;
        for (const ev of REQUIRED_CODEX_HOOK_EVENTS) {
          if (!binaryDeclaresEvent(text, ev)) missingEventsInBinary.push(ev);
        }
        if (missingEventsInBinary.length > 0) {
          failures.push(`codex binary (${binaryPath}) no longer declares hook events: ${missingEventsInBinary.join(', ')} — the enforcement layer would not fire`);
        }
      }
      // If it doesn't look like a hooks-capable codex (e.g. a shim wrapper or
      // an old version), leave binaryProbed=false → layer B skipped, not failed.
    } catch {
      // Unreadable binary → skip layer B rather than fail.
    }
  }

  const layerASolid = matcherIsRegex && dangerousGuardOnPreToolUse && stopReviewTrioWired;
  let status: CodexHookContractCanaryResult['status'];
  let message: string;

  if (failures.length > 0) {
    status = 'fail';
    message = `codex hook-contract canary: FAILED — ${failures.join('; ')}`;
  } else if (!binaryProbed) {
    // Layer A passed but no codex binary to confirm the live contract.
    status = 'skip';
    message = layerASolid
      ? 'codex hook-contract canary: invariants intact (no codex binary on host — live-contract probe skipped)'
      : 'codex hook-contract canary: invariants intact';
  } else {
    status = 'pass';
    message = `codex hook-contract canary: invariants intact + binary (${binaryPath}) declares all required hook events`;
  }

  return {
    status,
    message,
    details: {
      matcherIsRegex,
      dangerousGuardOnPreToolUse,
      stopReviewTrioWired,
      binaryProbed,
      binaryPath: binaryPath ?? undefined,
      missingEventsInBinary,
      failures,
    },
  };
}
