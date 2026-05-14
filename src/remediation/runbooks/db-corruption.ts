/**
 * db-corruption — W-4 wrapper runbook for SemanticMemory corruption recovery.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A1 (W-4), §A6 (structured-provenance
 * prefilter), §A9 (verify asserts durability not liveness), §A15 (supervisor-
 * handshake lag — enforced by the pre-merge gate, not at runtime), §A34
 * (surface-alignment: the corruption-recovery surface inside
 * `src/memory/SemanticMemory.ts` open() lines 178-243 IS the surface this
 * runbook wraps — verified live on main before the runbook landed), §A36
 * (essential requires blastRadius='machine'), §A57 (Tier-2 wrapper).
 *
 * Surface: `SemanticMemory.invokeFromRemediator(ctx)` (added by W-4 alongside
 * this file). The legacy in-line corruption-recovery entry point inside
 * `SemanticMemory.open()` stays unchanged as the CLI-path safety net; this
 * runbook is the parallel, Remediator-orchestrated path.
 *
 * Match contract:
 *   eventPrefilter.errorCode    = ['SQLITE_CORRUPT', 'SQLITE_NOTADB',
 *                                  'SQLITE_IOERR_CORRUPTFS']
 *   eventPrefilter.provenance   = ['native-binding', 'subsystem-explicit',
 *                                  'probe-id']
 *
 * `'free-text'` is intentionally NOT in the prefilter — §A6 mandates that
 * runbooks only fire on structured-provenance events. Free-text-extracted
 * SQLITE_* errors route to `no-matching-runbook` and feed SystemReviewer's
 * clustering pipeline rather than auto-triggering a recovery cycle.
 *
 * Verify (§A9 durability, not liveness):
 *   1. Acquire the targeted SemanticMemory instance (same one the
 *      surfaceCallable just rebuilt).
 *   2. Assert `db.mode === 'durable'`. A surface that fell back to
 *      in-memory mode is "live" but lossy → return `verify-failed` AND
 *      the surface separately emits a `DURABILITY_DEGRADED` event per §A9
 *      (non-silenceable, regardless of outcome matrix).
 *   3. Assert `PRAGMA integrity_check === 'ok'` on the actual db handle.
 *   4. A probe error (cannot inspect the handle) → `verify-inconclusive`
 *      per §A21 — distinct from `verify-failed`.
 *
 * essential:
 *   This runbook is `essential: true`. Database corruption hard-DoSes the
 *   knowledge graph and decision journal. Without the heal, the agent's
 *   persistent memory is gone. blastRadius is 'machine' (recovery
 *   touches the on-disk db + JSONL), which satisfies §A36's validator.
 */

import type { ApprovedRunbook } from '../Remediator.js';
import {
  SemanticMemory,
  type SemanticMemoryRemediatorContext,
} from '../../memory/SemanticMemory.js';

/**
 * Verify against the current active SemanticMemory instance.
 *
 *   - durable + integrity_check ok → verified-healthy
 *   - in-memory fallback         → verify-failed (and surface emits
 *                                   DURABILITY_DEGRADED per §A9)
 *   - integrity_check not 'ok'   → verify-failed
 *   - probe threw / no instance  → verify-inconclusive (§A21)
 */
function verifyDbDurable():
  | { kind: 'ok'; integrityValue: string }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'durability-degraded'; reason: string }
  | { kind: 'inconclusive'; reason: string } {
  try {
    const instance = SemanticMemory.getActiveInstanceForRemediator();
    if (!instance) {
      return {
        kind: 'inconclusive',
        reason: 'no active SemanticMemory instance registered',
      };
    }

    const mode = instance.getDurabilityMode();
    if (mode === 'closed') {
      return {
        kind: 'inconclusive',
        reason: 'SemanticMemory.db is closed after recovery',
      };
    }
    if (mode === 'in-memory') {
      // §A9: live-but-lossy is verify-failed; the surface emits
      // DURABILITY_DEGRADED on every health tick while in this state.
      return {
        kind: 'durability-degraded',
        reason: 'SemanticMemory fell back to in-memory mode (DURABILITY_DEGRADED)',
      };
    }

    // mode === 'durable' — now run the integrity check.
    let integrityValue = 'unknown';
    try {
      integrityValue = instance.runIntegrityCheckForRemediator();
    } catch (err) {
      return {
        kind: 'inconclusive',
        reason: `integrity_check threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (integrityValue === 'ok') {
      return { kind: 'ok', integrityValue };
    }
    return {
      kind: 'corrupt',
      reason: `integrity_check returned ${integrityValue}`,
    };
  } catch (err) {
    return {
      kind: 'inconclusive',
      reason: `verify wrapper threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Allow tests to inject a deterministic verify implementation. Production
 * code always uses the real `verifyDbDurable` above.
 */
type VerifyFn = typeof verifyDbDurable;
let _verifyImpl: VerifyFn = verifyDbDurable;
export function _setVerifyImplForTesting(fn: VerifyFn | null): void {
  _verifyImpl = fn ?? verifyDbDurable;
}

/**
 * Allow tests to inject a deterministic surfaceCallable. Production code
 * always invokes `SemanticMemory.invokeFromRemediator(ctx)`.
 */
type SurfaceFn = (
  ctx: SemanticMemoryRemediatorContext,
) => Promise<{ outcome: 'success' | 'failure'; details: Record<string, unknown> }>;
let _surfaceImpl: SurfaceFn = (ctx) =>
  SemanticMemory.invokeFromRemediator(ctx);
export function _setSurfaceImplForTesting(fn: SurfaceFn | null): void {
  _surfaceImpl = fn ?? ((ctx) => SemanticMemory.invokeFromRemediator(ctx));
}

export const dbCorruptionRunbook: ApprovedRunbook = {
  id: 'db-corruption',
  priority: 95,
  surface: 'db-corruption',
  eventPrefilter: {
    // SQLITE_CORRUPT: classic on-disk-page corruption.
    // SQLITE_NOTADB: file replaced / truncated / wrong magic.
    // SQLITE_IOERR_CORRUPTFS: filesystem-reported corruption (XFS/ext4 ESHUTDOWN
    //   propagated through better-sqlite3).
    errorCode: ['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_IOERR_CORRUPTFS'],
    // §A6: NOT free-text. Only structured-provenance events fire this runbook.
    // Native-binding: better-sqlite3 surfaces `err.code = 'SQLITE_CORRUPT'`.
    // Subsystem-explicit: SemanticMemory or callers set the code directly.
    // Probe-id: A52 probes (e.g. SemanticMemoryHealthProbe) that signed their
    //   envelope — verified by ProbeSourceRegistry at dispatch time.
    provenance: ['native-binding', 'subsystem-explicit', 'probe-id'],
  },
  match: (event) => {
    // Defence in depth — confirm the event is about a SemanticMemory-class
    // sqlite store. Other sqlite stores in the codebase (task-flow registry,
    // imessage NativeBackend) have their own recovery and shouldn't be
    // routed through this runbook.
    if (
      event.subsystem === 'semantic-memory' ||
      event.subsystem === 'memory' ||
      event.subsystem === 'better-sqlite3'
    ) {
      return true;
    }
    // Last-ditch: reason text mentions SemanticMemory by name.
    const reasonText = event.reason.full ?? event.reason.redacted ?? '';
    return /SemanticMemory/i.test(reasonText);
  },
  preconditions: async (_event) => {
    // The cheap guard: is there an active SemanticMemory instance registered?
    // If not, the recovery has nothing to act on and we leave it to a future
    // dispatch when the server has wired one up.
    return SemanticMemory.getActiveInstanceForRemediator() !== null;
  },
  surfaceCallable: async (ctx) => {
    return _surfaceImpl(ctx as SemanticMemoryRemediatorContext);
  },
  verify: async (_ctx) => {
    const result = _verifyImpl();
    switch (result.kind) {
      case 'ok':
        return {
          outcome: 'verified-healthy',
          reason: `db.mode=durable; integrity_check=${result.integrityValue}`,
        };
      case 'corrupt':
        return {
          outcome: 'verify-failed',
          reason: result.reason,
        };
      case 'durability-degraded':
        // §A9: live-but-lossy → verify-failed (durability lost). The surface
        // is independently responsible for emitting DURABILITY_DEGRADED.
        return {
          outcome: 'verify-failed',
          reason: result.reason,
        };
      case 'inconclusive':
        return {
          outcome: 'verify-inconclusive',
          reason: result.reason,
        };
    }
  },
  blastRadius: 'machine',
  reversibility: 'reversible',
  expectedRuntimeMs: 60_000,
  // §A36: essential requires blastRadius='machine' (satisfied above). DB
  // corruption hard-DoSes the knowledge graph until healed, so this is an
  // essential runbook on the same tier as node-abi-mismatch.
  essential: true,
};

// Re-export for tests / consumers that want the raw verify helper.
export { verifyDbDurable };
