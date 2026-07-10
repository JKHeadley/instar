/**
 * selfaction/anchor.ts — the PROCESS-GLOBAL anchor + single-mint registry
 * (companion §5.3, spec ADV8-1/ADV9-1).
 *
 * The mint registry AND the admission-state anchor live behind ONE
 * `Symbol.for('instar.selfActionGovernor')` key on `globalThis`, storing a
 * MINIMAL claim surface (never raw mutable maps). An accidental
 * dual-package/duplicated-dist load duplicates the whole module graph — a
 * module-scoped registry would see one clean claim per copy and guard nothing
 * in exactly its named case; the global key makes cross-copy claims COLLIDE
 * and shares ONE admission state so two copies can never run independent
 * full-budget counters or clobber the durable snapshot as uncoordinated
 * writers.
 *
 * Lifecycle: INIT-ONCE — the first claimant initializes, rehydrates, and owns
 * the single flush loop; a later claimant ATTACHES read-write, never
 * re-initializes, never starts a second flusher. A duplicate
 * `governor.for(id)` mint fails LOUDLY: controller-scoped errored posture
 * (never process-fatal) + a `mint-collision` audit row; the losing claimant's
 * dead handles resolve through the per-class fail direction.
 *
 * Test lifecycle (SC9-1): under vitest each module graph gets a graph-LOCAL
 * anchor by default (so unrelated test files never collide on a worker-shared
 * globalThis), and the mandated bounce/dual-load fixtures OPT IN to a shared
 * key via the key-salt override so they can exercise the collision + attach
 * cases within one process.
 */

const GLOBAL_KEY = 'instar.selfActionGovernor';
/** Test fixtures set `(globalThis as any)[Symbol.for(KEY_SALT_OVERRIDE)] = 'salt'`
 *  to force two freshly-imported module copies onto ONE shared anchor. */
export const KEY_SALT_OVERRIDE = 'instar.selfActionGovernor.keySaltOverride';

/** Module-LOCAL fallback symbol — unique per module graph (test isolation). */
const MODULE_LOCAL_KEY = Symbol('instar.selfActionGovernor.moduleLocal');

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
}

function anchorKey(): symbol {
  const salt = (globalThis as Record<symbol, unknown>)[Symbol.for(KEY_SALT_OVERRIDE)];
  if (typeof salt === 'string' && salt.length > 0) {
    return Symbol.for(`${GLOBAL_KEY}:${salt}`);
  }
  if (isTestEnv()) return MODULE_LOCAL_KEY;
  return Symbol.for(GLOBAL_KEY);
}

/**
 * The MINIMAL claim surface stored behind the global key. Deliberately not the
 * governor's raw maps: the anchor exposes claim/attach/mint bookkeeping plus
 * ONE opaque shared-state slot the initializing claimant owns.
 */
export interface GovernorAnchor {
  /** Monotonic claim generation (attach epochs). */
  generation: number;
  /** Whether an initializing claimant exists (owns rehydrate + flush loop). */
  initialized: boolean;
  /** Set of controller ids already minted (single-mint registry). */
  mintedControllerIds: Set<string>;
  /** Controller ids whose duplicate mint collided (dead-handle posture). */
  collidedControllerIds: Set<string>;
  /** The shared runtime state slot (owned by the first claimant; attached
   *  read-write by later claimants). Opaque here by design. */
  sharedState: unknown;
  /** Collision callback (installed by the initializing claimant so a losing
   *  mint from ANY copy lands one audit row). */
  onMintCollision?: (controllerId: string) => void;
}

/** Get-or-create the anchor behind the process-global key. */
export function getAnchor(): GovernorAnchor {
  const key = anchorKey();
  const g = globalThis as Record<symbol, unknown>;
  let anchor = g[key] as GovernorAnchor | undefined;
  if (!anchor) {
    anchor = {
      generation: 0,
      initialized: false,
      mintedControllerIds: new Set<string>(),
      collidedControllerIds: new Set<string>(),
      sharedState: null,
    };
    g[key] = anchor;
  }
  return anchor;
}

export type MintResult = { ok: true } | { ok: false; reason: 'mint-collision' };

/**
 * Single-mint per controller id, process-global. A second mint of the SAME id
 * (dual-load, copy-pasted marker file) COLLIDES: the second claimant's handle
 * is DEAD (controller-scoped errored posture — never process-fatal).
 */
export function mintController(controllerId: string): MintResult {
  const anchor = getAnchor();
  if (anchor.mintedControllerIds.has(controllerId)) {
    anchor.collidedControllerIds.add(controllerId);
    try {
      anchor.onMintCollision?.(controllerId);
    } catch {
      /* collision reporting must never throw into a module-scope mint */
    }
    return { ok: false, reason: 'mint-collision' };
  }
  anchor.mintedControllerIds.add(controllerId);
  return { ok: true };
}

/**
 * Claim the shared-state slot. INIT-ONCE: the first claimant provides the
 * initializer and OWNS the flush loop; later claimants ATTACH to the existing
 * state (never re-initialize, never start a second flusher).
 */
export function claimSharedState<T>(init: () => T): { state: T; role: 'initialized' | 'attached' } {
  const anchor = getAnchor();
  anchor.generation += 1;
  if (anchor.initialized && anchor.sharedState !== null) {
    return { state: anchor.sharedState as T, role: 'attached' };
  }
  const state = init();
  anchor.sharedState = state;
  anchor.initialized = true;
  return { state, role: 'initialized' };
}

/**
 * Test-only dispose/reset (SC9-1). Releases the anchor (mints + shared state)
 * so fixtures can re-instantiate within one process. Refuses outside a test
 * environment unless `force` — production code must never reset the anchor
 * (that would hand a runaway loop a fresh mint + budget surface).
 */
export function resetAnchorForTest(force = false): void {
  if (!isTestEnv() && !force) {
    throw new Error('resetAnchorForTest is test-only (set force to override deliberately)');
  }
  const key = anchorKey();
  const g = globalThis as Record<symbol, unknown>;
  delete g[key];
}
