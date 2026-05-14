/**
 * supervisor-preflight — the W-2 `ApprovedRunbook` wrapping
 * `ServerSupervisor.preflightSelfHeal` per spec A34 (composed-multi-step
 * surface alignment).
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A6 (errorCode provenance — structured
 * sources only), §A9 (verify asserts durability not just liveness), §A21
 * (verify probe error → verify-inconclusive, distinct from verify-failed),
 * §A34 (W-2 is ONE runbook composing six heal steps; verify produces a
 * SINGLE durable-state check after all steps), §A36 (essential requires
 * blastRadius='machine'), §A57 Tier-2 (W-2 ships after F-5, F-6, F-7,
 * F-8-rest are on main).
 *
 * Surface: `ServerSupervisor.invokeFromRemediator(ctx)` (added by W-2).
 * The legacy in-line `preflightSelfHeal()` call inside `spawnServer()`
 * stays unchanged as the boot-path safety net; this runbook is the
 * parallel, Remediator-orchestrated path.
 *
 * Match contract:
 *   eventPrefilter.errorCode    = ['BIND_FAILURE', 'CRASH_LOOP',
 *                                  'SUPERVISOR_DEGRADED']
 *   eventPrefilter.provenance   = ['native-binding', 'subsystem-explicit']
 *
 * `'free-text'` is intentionally NOT in the prefilter — §A6 mandates that
 * runbooks only fire on structured-provenance events. The match() callback
 * narrows further to lifeline/server subsystems so a same-errorCode event
 * about an unrelated subsystem (e.g., memory) routes to no-matching-runbook.
 *
 * Verify (§A9):
 *   The verify step asserts the durable lifeline state.json marker exists
 *   and was written recently (post-restart). Clean marker → verified-healthy.
 *   Missing or corrupt marker → verify-failed. Probe path error (filesystem
 *   I/O throws) → verify-inconclusive per §A21 — distinct from verify-failed.
 *
 * essential:
 *   This runbook is `essential: true`. A wedged supervisor (bind-failure
 *   crash loop, shadow-install missing, better-sqlite3 ABI mismatch,
 *   merged-conflict settings.json) DoSes every server-mediated capability:
 *   Telegram relay, dashboard, jobs scheduler, threadline. Without the
 *   heal, the agent is offline. blastRadius is 'machine' (preflight
 *   touches shadow-install/node_modules, the node symlink, the git tree,
 *   and the lifeline state directory), which satisfies §A36's validator.
 *
 * A15 partial-upgrade rule (Tier-2 build-acceleration carve-out):
 *   F-6 (the supervisor handshake the W-2 runbook depends on) merged on
 *   2026-05-13. The 7-day lag rule applies to PRODUCTION CUTOVER — turning
 *   the runbook live for end-users — not to the BUILD of the runbook code
 *   itself. The wrapper is constructible and unit-testable today; live
 *   activation gates on the separate `wrappers-active-after` config flag
 *   (defaults to false) and is the Tier-3 wiring PR's concern.
 */

import path from 'node:path';
import fs from 'node:fs';

import type { ApprovedRunbook, RemediationContext } from '../Remediator.js';
import { ServerSupervisor } from '../../lifeline/ServerSupervisor.js';
import { markerPath } from '../../lifeline/startupMarker.js';

// ── Verify probe ─────────────────────────────────────────────────────────

/**
 * §A9 durable-state assertion for the supervisor-preflight runbook. The
 * preflight heals six prerequisites:
 *
 *   1. shadow-install
 *   2. node symlink
 *   3. stuck git rebase
 *   4. better-sqlite3 ABI mismatch
 *   5. stale lifeline lock
 *   6. settings.json merge-conflict
 *
 * Verifying every step in isolation would multiply the verify surface six-
 * fold and re-implement detection logic the preflight body already owns.
 * Per §A34, the verify produces a SINGLE durable-state check: did the
 * lifeline re-spawn cleanly after the heal? The signal we read is the
 * `lifeline-started-at.json` startup marker — written unconditionally
 * by every lifeline startup, including the post-preflight one.
 *
 * Returns:
 *   - kind: 'ok'           — marker present, well-formed, fresh-enough
 *   - kind: 'failed'       — marker missing or corrupt (post-preflight
 *                            spawn did NOT happen → heal did not durably
 *                            recover the supervisor)
 *   - kind: 'inconclusive' — filesystem probe threw (cannot determine
 *                            durability one way or the other → §A21)
 */
export function verifyLifelineDurable(
  stateDir: string,
  options: { maxAgeMs?: number; nowMs?: number } = {},
):
  | { kind: 'ok'; markerStartedAt: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'inconclusive'; reason: string } {
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000; // 10 min default
  const now = options.nowMs ?? Date.now();
  try {
    const p = markerPath(stateDir);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          kind: 'failed',
          reason: `lifeline startup marker missing at ${p}`,
        };
      }
      // EACCES, EIO, etc — probe error, not durability failure.
      return {
        kind: 'inconclusive',
        reason: `marker readFileSync threw (${code ?? 'unknown'}): ${(err as Error).message}`,
      };
    }

    let parsed: { startedAt?: unknown; pid?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        kind: 'failed',
        reason: `marker JSON parse failed: ${(err as Error).message.slice(0, 200)}`,
      };
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.version !== 'string'
    ) {
      return {
        kind: 'failed',
        reason: 'marker shape invalid (missing startedAt/pid/version)',
      };
    }

    const startedAtMs = Date.parse(parsed.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return {
        kind: 'failed',
        reason: `marker startedAt is unparseable: ${parsed.startedAt}`,
      };
    }
    const ageMs = now - startedAtMs;
    if (ageMs > maxAgeMs) {
      return {
        kind: 'failed',
        reason: `marker is stale (ageMs=${ageMs} > maxAgeMs=${maxAgeMs}) — lifeline did not respawn post-heal`,
      };
    }
    // Negative age = clock skew or marker from the future. Treat as probe
    // error (§A21) rather than failure — we cannot confidently say durability
    // is broken when the clocks disagree.
    if (ageMs < -60_000) {
      return {
        kind: 'inconclusive',
        reason: `marker startedAt is in the future (ageMs=${ageMs}) — clock-skew probe error`,
      };
    }

    return { kind: 'ok', markerStartedAt: parsed.startedAt };
  } catch (err) {
    return {
      kind: 'inconclusive',
      reason: `verify wrapper threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Allow tests to inject a deterministic verify implementation. Production
 * code always uses the real `verifyLifelineDurable` above.
 */
type VerifyFn = (ctx: RemediationContext) =>
  | { kind: 'ok'; markerStartedAt: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'inconclusive'; reason: string };

let _verifyImpl: VerifyFn | null = null;
export function _setVerifyImplForTesting(fn: VerifyFn | null): void {
  _verifyImpl = fn;
}

/**
 * Allow tests to inject a stub supervisor so the runbook can run end-to-end
 * without spawning a real tmux session or touching the on-disk shadow-install.
 */
let _supervisorForTesting: Pick<ServerSupervisor, 'invokeFromRemediator'> | null =
  null;
export function _setSupervisorForTesting(
  s: Pick<ServerSupervisor, 'invokeFromRemediator'> | null,
): void {
  _supervisorForTesting = s;
}

/**
 * The state directory the verify step reads the lifeline marker from. Tests
 * inject a tmpdir; production callers configure this at runbook-registration
 * via a closure (the runbook factory) — for now, allow override.
 */
let _stateDirForVerify: string | null = null;
export function _setStateDirForVerify(dir: string | null): void {
  _stateDirForVerify = dir;
}

// ── Match helpers ────────────────────────────────────────────────────────

const SUPERVISOR_SUBSYSTEMS = new Set([
  'lifeline',
  'server',
  'supervisor',
  // Legacy emit-sites tag the server subsystem as 'http' in some places.
  // Match() narrows to those by inspecting reason text.
]);

const SUPERVISOR_ERROR_CODES = ['BIND_FAILURE', 'CRASH_LOOP', 'SUPERVISOR_DEGRADED'];

// ── ApprovedRunbook ──────────────────────────────────────────────────────

export const supervisorPreflightRunbook: ApprovedRunbook = {
  id: 'supervisor-preflight',
  // Lower than W-1 (node-abi-mismatch=100). When a BIND_FAILURE event also
  // carries a NATIVE_MODULE_ABI_MISMATCH errorCode (rare but possible during
  // crash-loop diagnosis), W-1's runbook is the right surface to dispatch
  // because it's the precise heal. supervisor-preflight is the broad heal
  // for the bind-failure root-cause class.
  priority: 90,
  surface: 'supervisor',
  eventPrefilter: {
    errorCode: SUPERVISOR_ERROR_CODES,
    // §A6: NOT free-text. Only structured-provenance events fire this runbook.
    provenance: ['native-binding', 'subsystem-explicit'],
  },
  match: (event) => {
    // Narrow to lifeline/server subsystems. Defence-in-depth: a BIND_FAILURE
    // event for an unrelated subsystem (e.g., a future memory-bind-failure)
    // should NOT trigger a supervisor preflight.
    if (SUPERVISOR_SUBSYSTEMS.has(event.subsystem)) return true;
    // Legacy free-text subsystems may use 'http' or 'tunnel' — inspect the
    // reason for an explicit supervisor/server/lifeline mention.
    const reasonText = event.reason.full ?? event.reason.redacted ?? '';
    return /\b(server|lifeline|supervisor)\b/i.test(reasonText);
  },
  preconditions: async (_event) => {
    // Cheap guard: stateDir must be set + accessible (the supervisor cannot
    // heal without somewhere to read/write shadow-install).
    if (!_stateDirForVerify) return true; // Production callers wire the dir
    try {
      fs.accessSync(_stateDirForVerify, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  surfaceCallable: async (ctx) => {
    const supervisor = _supervisorForTesting;
    if (!supervisor) {
      // Production callers must wire a supervisor instance via the runbook
      // factory pattern. Until that lands (Tier-3 dispatcher wiring), the
      // surfaceCallable returns a failure that surfaces in the audit
      // projection as `surfaceCallable returned outcome=failure`.
      return {
        outcome: 'failure',
        details: {
          reason: 'no-supervisor-wired',
          attemptId: ctx.attemptId,
        },
      };
    }
    const result = await supervisor.invokeFromRemediator(ctx);
    // The Remediator's `ExecutionResult` type matches the supervisor's
    // `SupervisorRemediatorExecutionResult` shape; pass through verbatim.
    return result;
  },
  verify: async (ctx) => {
    const impl = _verifyImpl;
    let probe:
      | { kind: 'ok'; markerStartedAt: string }
      | { kind: 'failed'; reason: string }
      | { kind: 'inconclusive'; reason: string };
    if (impl) {
      probe = impl(ctx);
    } else if (_stateDirForVerify) {
      probe = verifyLifelineDurable(_stateDirForVerify);
    } else {
      probe = {
        kind: 'inconclusive',
        reason: 'no stateDir wired for verify — cannot read lifeline marker',
      };
    }
    switch (probe.kind) {
      case 'ok':
        return {
          outcome: 'verified-healthy',
          reason: `lifeline marker present (startedAt=${probe.markerStartedAt}); preflight durable`,
        };
      case 'failed':
        return { outcome: 'verify-failed', reason: probe.reason };
      case 'inconclusive':
        return { outcome: 'verify-inconclusive', reason: probe.reason };
    }
  },
  blastRadius: 'machine',
  reversibility: 'reversible',
  // 3 minutes. Cold-cache shadow-install reinstall + better-sqlite3 rebuild
  // can both run in one preflight cycle; each takes ~30-60s on slow hardware.
  // The deadline race in F-8 will abort with `aborted-deadline` if exceeded.
  expectedRuntimeMs: 180_000,
  // §A36: essential requires blastRadius='machine' (satisfied above). A
  // wedged supervisor DoSes every server-mediated capability, so this is the
  // canonical essential runbook for the supervisor surface.
  essential: true,
};

// Re-export the path helper so consumers can compute the marker location
// without re-importing from `src/lifeline/startupMarker.ts`.
export { markerPath as supervisorMarkerPath };

// For tests/observability — list the durable state assertions.
export const VERIFIED_HEAL_TARGETS = [
  'shadow-install',
  'node-symlink',
  'git-rebase',
  'better-sqlite3-abi',
  'stale-lifeline-lock',
  'settings-json',
] as const;

/** No-op compile-time use to keep `path` import alive for future helpers. */
const _ = path;
void _;
