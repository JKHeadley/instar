/**
 * The green that earns `shadow` for a pool started at pairing
 * (docs/specs/session-pool-activation-at-pairing.md, Changes 5 and 6).
 *
 * A new agent cannot run the failover test, so a held readiness report stands in. It means
 * the prerequisites held, not that a conversation was placed; the ladder measures that, and
 * the `shadow` ceiling is why this weaker evidence is enough.
 */
import type { SessionPoolE2EResultStore } from './SessionPoolE2EResultStore.js';
import type { RebalanceProofState } from './StageAdvancer.js';

export const PAIR_GREEN_HOLD_MS = 10 * 60_000;
export const PAIR_GREEN_MAX_AGE_MS = 24 * 60 * 60_000;
/** Renew well inside the expiry, without growing the append-only file on every tick. */
export const PAIR_GREEN_RENEW_MS = 6 * 60 * 60_000;
export const PAIR_GREEN_EVIDENCE_PREFIX = 'readiness:';

/** Fresh means a verified green under a day old, and a machine to share with. */
export function pairShadowProofState(
  store: SessionPoolE2EResultStore,
  nowMs: number,
  hasPeer: boolean,
): RebalanceProofState {
  if (!hasPeer) return { fresh: false, detail: 'no-peer' };
  const latest = store.getLatestForStage(0);
  if (!latest) return { fresh: false, detail: 'no-result' };
  if (!store.verify(latest)) return { fresh: false, detail: 'bad-signature' };
  if (latest.result !== 'green') return { fresh: false, detail: 'red' };
  if (nowMs - Date.parse(latest.ranAt) > PAIR_GREEN_MAX_AGE_MS) return { fresh: false, detail: 'expired' };
  return { fresh: true, detail: 'fresh' };
}

export interface PairGreenProducerDeps {
  store: SessionPoolE2EResultStore;
  commitSha: () => string;
  /** The readiness report's own verdict, read live. */
  ready: () => boolean;
  now: () => number;
}

export class PairGreenProducer {
  private readySince: number | null = null;

  constructor(private readonly d: PairGreenProducerDeps) {}

  /** Call on each promotion tick. Returns true when it recorded a green. */
  tick(): boolean {
    const now = this.d.now();
    if (!this.d.ready()) {
      this.readySince = null;
      return false;
    }
    this.readySince ??= now;
    if (now - this.readySince < PAIR_GREEN_HOLD_MS) return false;

    const sha = this.d.commitSha();
    // `reconcile` lets a newer stage-0 green supersede a stage-1 red, so this evidence must
    // never be written over a real failure of this build.
    const rows = this.d.store.all();
    if (rows.some((r) => r.stage <= 1 && r.result === 'red' && r.commitSha === sha && this.d.store.verify(r))) return false;

    const latest = this.d.store.getLatestForStage(0);
    if (latest && latest.result === 'green' && latest.commitSha === sha && this.d.store.verify(latest)
      && now - Date.parse(latest.ranAt) < PAIR_GREEN_RENEW_MS) return false;

    this.d.store.recordResult(0, 'green', sha, `${PAIR_GREEN_EVIDENCE_PREFIX}held-${PAIR_GREEN_HOLD_MS / 60_000}m`);
    return true;
  }
}
