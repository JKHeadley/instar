/**
 * ExternalHogNoticeCoalescer — the P17 notification-bounding of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §6).
 *
 * A SINGLE coalescing chokepoint over EVERY notice class — kills, decider-unavailable alerts,
 * floor-veto downgrades, and the deterministic "sustained hog left alive" observability
 * alerts — so a persistent condition (a hog the model keeps sparing, a provider outage) raises
 * ONE coalesced notice, not one-per-scan. Pure selection logic (the actual delivery is the
 * caller's). Rules (§6):
 *   - per-signature DEDUP: the same (class, signature) within the window collapses to one.
 *   - per-window BUDGET (`noticeBudgetPerWindow`): at most N notices per window.
 *   - budget-exhaustion SEVERITY ORDER: kill > decider-unavailable > floor-veto-downgrade >
 *     hog-left-alive. Lower classes are dropped first, and the DROPPED count is reported.
 *   - a LIVE KILL notice ALWAYS pierces the budget (never dropped) — an actual kill must be
 *     surfaced no matter how noisy the window is.
 */

export type NoticeClass = 'kill' | 'decider-unavailable' | 'floor-veto-downgrade' | 'hog-left-alive';

/** Severity for budget-exhaustion ordering (higher = kept first). */
const CLASS_SEVERITY: Record<NoticeClass, number> = {
  kill: 3,
  'decider-unavailable': 2,
  'floor-veto-downgrade': 1,
  'hog-left-alive': 0,
};

export interface Notice {
  readonly cls: NoticeClass;
  /** Per-signature dedup key (e.g. the command-hash / class id). */
  readonly signature: string;
  /** Human-facing text (already scrubbed by the caller). */
  readonly text: string;
}

export interface CoalesceResult {
  /** The notices to actually emit this cycle (deduped, budget-bounded, kills always kept). */
  readonly emitted: readonly Notice[];
  /** How many notices of each class were dropped by the budget (for the coalesced summary). */
  readonly droppedByClass: Readonly<Partial<Record<NoticeClass, number>>>;
  /** Total dropped. */
  readonly droppedTotal: number;
}

export interface CoalesceOpts {
  /** Max notices per window (default 4). Live kills are exempt (always kept). */
  readonly budgetPerWindow: number;
  /** Signatures already emitted earlier in this window (per-signature dedup across the window). */
  readonly alreadyEmittedSignatures?: ReadonlySet<string>;
}

/**
 * Select which notices to emit this cycle. Dedups by (class, signature) within the batch and
 * against `alreadyEmittedSignatures`, keeps ALL live kills (they pierce the budget), then fills
 * the remaining budget with the highest-severity classes first; the rest are dropped and
 * counted. Pure — returns a new result, mutates nothing.
 */
export function coalesceNotices(notices: readonly Notice[], opts: CoalesceOpts): CoalesceResult {
  const budget = Number.isFinite(opts.budgetPerWindow) && opts.budgetPerWindow > 0 ? Math.floor(opts.budgetPerWindow) : 0;
  const already = opts.alreadyEmittedSignatures ?? new Set<string>();

  // (1) per-signature dedup within the batch (first wins) AND vs the window's prior emissions.
  const seen = new Set<string>();
  const deduped: Notice[] = [];
  for (const n of notices) {
    if (!n || !isNoticeClass(n.cls)) continue;
    const key = `${n.cls}::${n.signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (already.has(key)) continue; // already surfaced this window
    deduped.push(n);
  }

  // (2) live kills ALWAYS pierce the budget.
  const kills = deduped.filter((n) => n.cls === 'kill');
  const nonKills = deduped.filter((n) => n.cls !== 'kill');

  // (3) fill the remaining budget with the highest-severity non-kill classes first (stable).
  const remaining = Math.max(0, budget - kills.length);
  const orderedNonKills = [...nonKills].sort((a, b) => CLASS_SEVERITY[b.cls] - CLASS_SEVERITY[a.cls]);
  const keptNonKills = orderedNonKills.slice(0, remaining);
  const droppedNonKills = orderedNonKills.slice(remaining);

  const droppedByClass: Partial<Record<NoticeClass, number>> = {};
  for (const n of droppedNonKills) droppedByClass[n.cls] = (droppedByClass[n.cls] ?? 0) + 1;

  return {
    emitted: [...kills, ...keptNonKills],
    droppedByClass,
    droppedTotal: droppedNonKills.length,
  };
}

function isNoticeClass(c: unknown): c is NoticeClass {
  return c === 'kill' || c === 'decider-unavailable' || c === 'floor-veto-downgrade' || c === 'hog-left-alive';
}
