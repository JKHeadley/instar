/**
 * Builtin app summaries (docs/specs/project-apps.md §3.4). Derived, never stored.
 *
 * The maturation board's summary comes from the board's own pool-scope read, fetched over this
 * server's loopback so it reuses that route's 60 s response cache and its pool rate limit exactly.
 * The Work read never awaits it: `get()` returns the last value and starts one refresh when the
 * value is older than the board's cache window. A rate-limited refresh keeps the last value.
 */
import type { BuiltinSummary } from './ProjectAppsRuntime.js';

export const SUMMARY_STALE_MS = 60_000;

export interface MaturationBoardCounts {
  features?: number; live?: number; stalledRegressedBlind?: number; pastDate?: number;
}

/** The summary from one board answer (pure; spec §3.4). Never zeros for a board that could not be read. */
export function maturationSummaryFrom(body: unknown): BuiltinSummary {
  const b = (body ?? {}) as { counts?: MaturationBoardCounts & { byVerdict?: Record<string, number> }; generatedAt?: unknown; reviewMachine?: unknown; reviewState?: unknown };
  const c = b.counts;
  if (!c || !Number.isFinite(c.features) || typeof b.generatedAt !== 'string') return { state: 'unreadable', why: 'The board answered in a shape this page cannot read.' };
  if (!b.reviewMachine) return { state: 'unreadable', why: "The board's reviews couldn't be read on any machine." };
  const live = Number(c.live ?? c.byVerdict?.live ?? 0);
  const srb = Number(c.stalledRegressedBlind ?? 0);
  const past = Number(c.pastDate ?? 0);
  return {
    state: 'ok',
    headline: `${c.features} features: ${live} live, ${srb} stalled, regressed or blind`,
    counts: [
      { label: 'Live', value: live, tone: 'ok' },
      { label: 'Stalled, regressed or blind', value: srb, tone: srb ? 'attn' : 'quiet' },
      { label: 'Past their date', value: past, tone: past ? 'attn' : 'quiet' },
    ],
    asOf: b.generatedAt,
  };
}

export interface SummaryFetch { (path: string): Promise<{ status: number; body: unknown }> }

export class MaturationSummaryProvider {
  private value: BuiltinSummary = { state: 'pending', why: 'Reading the board…' };
  private at = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: { fetch: SummaryFetch; enabled: () => boolean; now?: () => number; onLanded?: () => void }) {}

  get(): BuiltinSummary {
    if (!this.deps.enabled()) return { state: 'unreadable', why: 'The board is switched off on this agent.', action: { label: 'Turn it on', href: '#/settings' } };
    const now = this.deps.now ? this.deps.now() : Date.now();
    if (!this.inFlight && now - this.at >= SUMMARY_STALE_MS) this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.value;
  }

  /** One refresh (exposed for tests). */
  async refresh(): Promise<void> {
    const now = this.deps.now ? this.deps.now() : Date.now();
    try {
      const r = await this.deps.fetch('/maturation/board?scope=pool');
      if (r.status === 429) { this.at = now; return; } // keep the last value and its as-of time
      if (r.status !== 200) { this.value = { state: 'unreadable', why: `The board answered ${r.status}.` }; this.at = now; this.deps.onLanded?.(); return; }
      this.value = maturationSummaryFrom(r.body);
      this.at = now;
      this.deps.onLanded?.();
    } catch {
      this.value = { state: 'unreadable', why: 'The board could not be reached.' }; // @silent-fallback-ok — named on the row, never zeros
      this.at = now;
      this.deps.onLanded?.();
    }
  }
}
