/**
 * Slice budgets and slice order (docs/specs/local-verify-borrowed-slices-count.md, E). Shared by
 * both sides: the run machine cuts a lane's helper share into slices with `cutSlices`, and the
 * helper refuses a slice whose stated budget is above its lane's and serves waiting slices in
 * `sliceClassRank` order.
 *
 * Pure: no I/O.
 */
import { HELPER_LIMITS, type HelperLane, type HelperSliceUse } from './helperProtocol.js';

/** A lane's slice budget in helper time: 60 s for integration and end-to-end, 10 s for unit. */
export function sliceBudgetMs(lane: HelperLane): number {
  return HELPER_LIMITS.sliceBudgetMs[lane];
}

/**
 * Cut files into slices of at most one budget of helper time each, keeping the given order.
 * `helperMs` is each file's expected time ON THE HELPER (the caller scales its own recorded times
 * by the helper's measured speed). A file longer than the budget goes alone; a file exactly at
 * the budget still shares nothing with a file that would pass it. A file with no usable time
 * (absent, negative, not finite) counts as one whole budget, so it goes alone too: nothing is
 * known about it. No file is dropped and no slice is over `maxFilesPerRequest` files.
 */
export function cutSlices(files: ReadonlyArray<{ file: string; helperMs: number }>, lane: HelperLane): string[][] {
  const budget = sliceBudgetMs(lane);
  const out: string[][] = [];
  let cur: string[] = [];
  let curMs = 0;
  const flush = (): void => { if (cur.length > 0) { out.push(cur); cur = []; curMs = 0; } };
  for (const f of files) {
    const ms = Number.isFinite(f.helperMs) && f.helperMs >= 0 ? f.helperMs : budget;
    if (ms > budget) { flush(); out.push([f.file]); continue; }
    if (cur.length > 0 && (curMs + ms > budget || cur.length >= HELPER_LIMITS.maxFilesPerRequest)) flush();
    cur.push(f.file);
    curMs += ms;
  }
  flush();
  return out;
}

/**
 * The order a helper serves waiting slices in (spec E "Order of slices"): the check slice first,
 * then slices whose results will be used, then compare-only slices. Lower runs first; within one
 * class, the order of arrival.
 */
export function sliceClassRank(use: HelperSliceUse): number {
  return use === 'check' ? 0 : use === 'count' ? 1 : 2;
}

/** Workers for a slice: as many as the governor allows for unit, one for integration and end-to-end (files one at a time). */
export function sliceWorkers(lane: HelperLane, governorAllows: number): number {
  return lane === 'unit' ? Math.max(1, governorAllows) : 1;
}
