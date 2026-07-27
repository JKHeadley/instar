/**
 * recurrenceLoop — the caller that makes the loop actually close.
 *
 * `RecurrenceReader` sees. `RecurrenceActuator` decides. Neither touches a store,
 * which is what keeps both pure and testable — but it also meant "the loop
 * closes" was a DESIGNED property and not a demonstrated one. This is the piece
 * that demonstrates it: it reads the three stores, plans, and writes the result
 * through the caller-supplied action-creation function.
 *
 * It is deliberately the ONLY place in this feature that performs I/O, so every
 * read failure has exactly one place to be reported from and cannot be swallowed
 * somewhere in the middle.
 *
 * Operator directive 2026-07-26 20:08Z: synthesis must lead to ACTION, through
 * paths that already exist, with the loop closed and minimal user dependence.
 */

import {
  buildRecurrenceReport,
  type Coverage,
  type Observation,
  type RecurrenceReport,
} from './RecurrenceReader.js';
import { planActuation, type ActuationOptions, type ProposedAction } from './RecurrenceActuator.js';

/** Reads one store. Returning a rejected promise is how it reports "unreadable". */
export type StoreReader = () => Promise<Observation[]>;

export interface LoopDeps {
  readAttention: StoreReader;
  readActions: StoreReader;
  readSentinel: StoreReader;
  /**
   * Creates ONE tracked action. The caller supplies this so the write goes
   * through whatever path it already uses, with whatever gating that path
   * already has. This module never constructs an HTTP call itself.
   */
  createAction: (a: ProposedAction) => Promise<{ id: string }>;
}

export interface LoopResult {
  report: RecurrenceReport;
  /** Actions actually created, with the ids the store returned. */
  created: { id: string; title: string; observedCount: number }[];
  /** Set when the actuator declined; `created` is then empty. */
  refused?: { reason: string; detail: string };
  /** Qualifying clusters held back by the per-run cap. */
  deferredByCap: number;
  /**
   * Proposals whose WRITE failed. Distinct from `refused` (a decision not to
   * act) — this is a decision to act that did not land, and conflating the two
   * would hide real breakage behind a principled-looking refusal.
   */
  writeFailures: { title: string; error: string }[];
}

/** Read a store, converting failure into a named coverage gap rather than a throw. */
async function readOrRecord(
  store: Observation['store'],
  read: StoreReader,
  into: Observation[],
  coverage: Coverage,
): Promise<void> {
  try {
    into.push(...(await read()));
    coverage.read.push(store);
  } catch (err) {
    coverage.unreadable.push({
      store,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
  }
}

/**
 * Run one pass: read → group → plan → create.
 *
 * Never throws for an unreadable store — that is data, reported in
 * `report.coverage`, and it is what the actuator's refusal reads.
 */
export async function runRecurrenceLoop(
  deps: LoopDeps,
  opts: ActuationOptions = {},
): Promise<LoopResult> {
  const observations: Observation[] = [];
  const coverage: Coverage = { read: [], unreadable: [], completeness: 'complete' };

  await readOrRecord('attention', deps.readAttention, observations, coverage);
  await readOrRecord('actions', deps.readActions, observations, coverage);
  await readOrRecord('sentinel', deps.readSentinel, observations, coverage);
  coverage.completeness = coverage.unreadable.length === 0 ? 'complete' : 'partial';

  const report = buildRecurrenceReport(observations, coverage);
  const plan = planActuation(report, opts);

  if (plan.refused) {
    return {
      report,
      created: [],
      refused: plan.refused,
      deferredByCap: plan.deferredByCap,
      writeFailures: [],
    };
  }

  const created: LoopResult['created'] = [];
  const writeFailures: LoopResult['writeFailures'] = [];

  for (const proposal of plan.propose) {
    try {
      const { id } = await deps.createAction(proposal);
      created.push({ id, title: proposal.title, observedCount: proposal.observedCount });
    } catch (err) {
      // A failed write is NOT a refusal. Recording it separately keeps a real
      // outage from reading as a principled decision not to act — which would be
      // this project's own failure mode (absence presenting as presence) at the
      // very end of the loop it exists to close.
      writeFailures.push({
        title: proposal.title,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
    }
  }

  return { report, created, deferredByCap: plan.deferredByCap, writeFailures };
}
