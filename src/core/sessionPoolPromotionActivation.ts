/**
 * Session-pool promotion activation — the reversible runtime switch that turns
 * the already-merged SessionPoolRolloutDriver into either a cadenced auto-climb
 * or an operator-triggered one-step lever.
 */

import {
  SessionPoolRolloutDriver,
  type RolloutTickResult,
} from './SessionPoolRolloutDriver.js';
import {
  stageIndex,
  type SessionPoolStage,
} from './StageAdvancer.js';

export type SessionPoolPromotionModel = 'auto-climb' | 'operator' | 'off';

export interface SessionPoolPromotionConfigBlock {
  promotionModel?: SessionPoolPromotionModel;
  /** Highest stage either promotion model may reach. Default dark (no authority). */
  promotionCeiling?: SessionPoolStage;
  /** Cadence for auto-climb. Floored at 60s. */
  promotionTickMs?: number;
}

export interface SessionPoolPromotionResolvedConfig {
  model: SessionPoolPromotionModel;
  ceiling: SessionPoolStage;
  tickMs: number;
}

const MIN_TICK_MS = 60_000;
const DEFAULT_TICK_MS = 60_000;

export function resolveSessionPoolPromotionConfig(
  block: SessionPoolPromotionConfigBlock | undefined,
): SessionPoolPromotionResolvedConfig {
  const model: SessionPoolPromotionModel =
    block?.promotionModel === 'auto-climb' ||
    block?.promotionModel === 'operator'
      ? block.promotionModel
      : 'off';
  const ceiling =
    block?.promotionCeiling && stageIndex(block.promotionCeiling) >= 0
      ? block.promotionCeiling
      : 'dark';
  const rawTick = Number(block?.promotionTickMs);
  const tickMs = Number.isFinite(rawTick)
    ? Math.max(MIN_TICK_MS, Math.floor(rawTick))
    : DEFAULT_TICK_MS;
  return { model, ceiling, tickMs };
}

export interface SessionPoolPromotionStatus {
  model: SessionPoolPromotionModel;
  ceiling: SessionPoolStage;
  tickMs: number;
  lastAutoTickAt: string | null;
  lastResult: RolloutTickResult | null;
}

export class SessionPoolPromotionActivation {
  private lastAutoTickAt: string | null = null;
  private lastResult: RolloutTickResult | null = null;

  constructor(
    private readonly config: SessionPoolPromotionResolvedConfig,
    private readonly driver: SessionPoolRolloutDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Auto path: a strict no-op unless the operator selected auto-climb. */
  autoTick(): RolloutTickResult | null {
    if (this.config.model !== 'auto-climb') return null;
    const result = this.driver.tick();
    this.lastAutoTickAt = this.now().toISOString();
    this.lastResult = result;
    return result;
  }

  /** Manual path: available in operator and auto-climb models; off stays dark. */
  promoteOne(): RolloutTickResult | null {
    if (this.config.model === 'off') return null;
    const result = this.driver.tick();
    this.lastResult = result;
    return result;
  }

  status(): SessionPoolPromotionStatus {
    return {
      model: this.config.model,
      ceiling: this.config.ceiling,
      tickMs: this.config.tickMs,
      lastAutoTickAt: this.lastAutoTickAt,
      lastResult: this.lastResult,
    };
  }
}
