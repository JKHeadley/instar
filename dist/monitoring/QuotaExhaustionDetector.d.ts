/**
 * Quota Exhaustion Detector — classifies WHY a session died.
 *
 * Pattern-matches tmux output from a dead session against known
 * failure signatures, cross-references with quota state to produce
 * a confidence-weighted classification.
 *
 * Use cases:
 * - Skip ledger: record quota_exhaustion vs crash vs normal_exit
 * - Telegram alerts: "session died because quota exhausted"
 * - Auto-recovery: trigger account switch on repeated quota deaths
 *
 * Ported from Dawn's dawn-server/src/quota/QuotaExhaustionDetector.ts,
 * simplified for general Instar use (no Telegram dependency).
 */
import type { QuotaState, SessionDeathClassification } from '../core/types.js';
/**
 * Classify why a session died based on its terminal output and quota state.
 */
export declare function classifySessionDeath(tmuxOutput: string, quotaState?: QuotaState | null): SessionDeathClassification;
//# sourceMappingURL=QuotaExhaustionDetector.d.ts.map