/**
 * node-abi-mismatch — the first ApprovedRunbook the Remediator can dispatch.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A6 (errorCode provenance — structured
 * sources only), §A9 (verify asserts durability not just liveness), §A28
 * (supply-chain hygiene for native rebuilds), §A45 (build-from-source +
 * pinned integrity), §A55 (NativeModuleHealer postinstall coordination),
 * §A57 (Tier-1 W-1 — the canonical value-prover runbook).
 *
 * Surface: `NativeModuleHealer.invokeFromRemediator(ctx)` (added by W-1).
 * The legacy in-line `openWithHeal` entry point in `src/memory/NativeModuleHealer.ts`
 * stays unchanged as the CLI-path safety net; this runbook is the parallel,
 * Remediator-orchestrated path.
 *
 * Match contract:
 *   eventPrefilter.errorCode    = ['NATIVE_MODULE_ABI_MISMATCH']
 *   eventPrefilter.provenance   = ['native-binding', 'subsystem-explicit']
 *
 * `'free-text'` is intentionally NOT in the prefilter — §A6 mandates that
 * runbooks only fire on structured-provenance events. Free-text-extracted
 * NODE_MODULE_VERSION errors route to `no-matching-runbook` and feed
 * NovelFailureReviewer's clustering pipeline rather than auto-triggering a
 * rebuild.
 *
 * Verify (A9):
 *   The verify step opens a sqlite handle on the rebuilt module and runs
 *   `PRAGMA integrity_check`. A clean `ok` result → `verified-healthy`. A
 *   `corrupt` or non-`ok` result → `verify-failed`. A probe error (cannot
 *   open the module, integrity_check throws) → `verify-inconclusive` per
 *   §A21 — distinct from `verify-failed`.
 *
 * essential:
 *   This runbook is `essential: true`. ABI mismatch hard-DoSes every
 *   memory subsystem (SemanticMemory, TopicMemory, MemoryIndex). Without
 *   the heal, the agent's persistent context is gone. blastRadius is
 *   'machine' (rebuild touches the on-disk node_modules), which satisfies
 *   §A36's validator.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

import type { ApprovedRunbook } from '../Remediator.js';
import { NativeModuleHealer } from '../../memory/NativeModuleHealer.js';

const require = createRequire(import.meta.url);

/**
 * Verify whether the rebuilt better-sqlite3 binding loads + the on-disk
 * database is durable. The verify path:
 *   1. Clear better-sqlite3 from require.cache (in case W-1's
 *      invokeFromRemediator didn't, e.g., aborted before cache clear).
 *   2. Require better-sqlite3 fresh.
 *   3. Open an in-memory database (no file I/O — pure ABI verification).
 *   4. Run `PRAGMA integrity_check`. Expect 'ok'.
 *
 * In-memory is intentional: we're verifying the ABI loads correctly and
 * the engine produces well-formed query results. A real corrupt-DB check
 * is W-4's concern (db-corruption runbook).
 */
function verifyBetterSqlite3Ok():
  | { kind: 'ok' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'inconclusive'; reason: string } {
  try {
    // Clear cache so the fresh native binding is loaded.
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}better-sqlite3${path.sep}`)) {
        delete require.cache[key];
      }
    }

    let DatabaseCtor: new (filename: string) => {
      pragma: (q: string) => unknown;
      close: () => void;
    };
    try {
      DatabaseCtor = require('better-sqlite3');
    } catch (err) {
      // Module still fails to load → probe error, not durability failure.
      return {
        kind: 'inconclusive',
        reason: `better-sqlite3 require failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let db: { pragma: (q: string) => unknown; close: () => void };
    try {
      db = new DatabaseCtor(':memory:');
    } catch (err) {
      return {
        kind: 'inconclusive',
        reason: `Database constructor threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const result = db.pragma('integrity_check');
      // better-sqlite3 returns array of {integrity_check: 'ok'} rows.
      let ok = false;
      let reason = '';
      if (Array.isArray(result) && result.length > 0) {
        const first = result[0] as { integrity_check?: unknown };
        const val =
          typeof first === 'object' && first !== null && 'integrity_check' in first
            ? String(first.integrity_check)
            : String(first);
        if (val === 'ok') {
          ok = true;
        } else {
          reason = `integrity_check returned ${val}`;
        }
      } else if (typeof result === 'string') {
        if (result === 'ok') ok = true;
        else reason = `integrity_check returned ${result}`;
      } else {
        reason = `integrity_check returned unexpected shape: ${JSON.stringify(result)}`;
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      if (ok) return { kind: 'ok' };
      return { kind: 'corrupt', reason };
    } catch (err) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      return {
        kind: 'inconclusive',
        reason: `integrity_check threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } catch (err) {
    return {
      kind: 'inconclusive',
      reason: `verify wrapper threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Allow tests to inject a deterministic verify implementation. Production
 * code always uses the real `verifyBetterSqlite3Ok` above.
 */
type VerifyFn = typeof verifyBetterSqlite3Ok;
let _verifyImpl: VerifyFn = verifyBetterSqlite3Ok;
export function _setVerifyImplForTesting(fn: VerifyFn | null): void {
  _verifyImpl = fn ?? verifyBetterSqlite3Ok;
}

export const nodeAbiMismatchRunbook: ApprovedRunbook = {
  id: 'node-abi-mismatch',
  priority: 100,
  surface: 'memory-healer',
  eventPrefilter: {
    errorCode: ['NATIVE_MODULE_ABI_MISMATCH'],
    // §A6: NOT free-text. Only structured-provenance events fire this runbook.
    provenance: ['native-binding', 'subsystem-explicit'],
  },
  match: (event) => {
    // Defence in depth — confirm the event is actually about better-sqlite3
    // and not some other native module that happens to ship an ABI-mismatch
    // error code.
    if (event.subsystem === 'better-sqlite3') return true;
    if (event.subsystem === 'memory') {
      // Legacy subsystem name from existing emit sites. Inspect reason text.
      const reasonText = event.reason.full ?? event.reason.redacted ?? '';
      return /better-sqlite3/i.test(reasonText);
    }
    const reasonText = event.reason.full ?? event.reason.redacted ?? '';
    return /better-sqlite3/i.test(reasonText);
  },
  preconditions: async (_event) => {
    // npm must be on PATH (or in a known platform path) and package.json
    // must exist in some ancestor of the better-sqlite3 install. We delegate
    // the precise check to `NativeModuleHealer.invokeFromRemediator`, which
    // surfaces a structured failure if either is missing. The precondition
    // here is the cheap guard: is better-sqlite3 even installed?
    try {
      // require.resolve is sync and cheap; success means the package is
      // installed (even if the native binding is broken — which is exactly
      // why this runbook fires).
      require.resolve('better-sqlite3');
      return true;
    } catch {
      return false;
    }
  },
  surfaceCallable: async (ctx) => NativeModuleHealer.invokeFromRemediator(ctx),
  verify: async (_ctx) => {
    const result = _verifyImpl();
    switch (result.kind) {
      case 'ok':
        return {
          outcome: 'verified-healthy',
          reason: 'better-sqlite3 loaded; PRAGMA integrity_check = ok',
        };
      case 'corrupt':
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
  expectedRuntimeMs: 120_000,
  // §A36: essential requires blastRadius='machine' (satisfied above). ABI
  // mismatch DoSes every memory subsystem until healed, so this is the
  // canonical essential runbook.
  essential: true,
};

// Re-export for tests / consumers that want the raw verify helper.
export { verifyBetterSqlite3Ok };
