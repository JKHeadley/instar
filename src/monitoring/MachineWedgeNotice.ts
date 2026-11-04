/**
 * The wedge dry-run operator notice (docs/specs/machine-self-maintenance.md, Part E
 * rung 7: "While wedge restart is in dry-run, a confirmed candidate reaches this at
 * once with no rungs run: the notice is real").
 *
 * OFF by default in this build: the caller sends it only when
 * `machineMaintenance.wedgeRestart.dryRunNotice` is true. Bounds, in order:
 *   1. one notice per candidate episode (the attention item id is the episode, so the
 *      attention store deduplicates a repeat too);
 *   2. the self-action governor (`machine-wedge-notice`: 1 per machine per 24 h, 3 in
 *      all per 24 h);
 *   3. the WedgeMonitor's own brakes upstream (one judge and one notice per episode).
 *
 * The spec's notice "carries Restart now". That control is not built, so the notice
 * says so plainly instead of offering a button that does nothing. Text is fixed
 * wording plus reason codes; never window titles, dialog text or command output.
 */

/* @self-action-controller: machine-wedge-notice */

import { consumeAdmissionToken, governor } from './selfaction/governor.js';
import type { DerivedTarget } from './selfaction/types.js';
import type { WedgeNoticeInput, WedgeNoticeOutcome } from './machineMaintenance/WedgeMonitor.js';

const wedgeNoticeGov = governor.for('machine-wedge-notice');

/** Canonical target: one key per machine (episodes on one machine share the per-target ceiling). */
export function deriveTargetKey(machineId: string): DerivedTarget {
  return { key: `machine-wedge-notice:${machineId}`, classId: 'machine-wedge-notice', keyIsVolatile: false };
}

export interface WedgeAttentionItem {
  id: string;
  title: string;
  summary: string;
  description: string;
  category: string;
  priority: 'NORMAL' | 'HIGH';
  sourceContext: string;
}

const REASON_WORDS: Record<string, string> = {
  'ps-timed-out': 'listing processes timed out',
  'fork-failure': 'the system could not start a new process',
  'uninterruptible-rising': 'stuck processes keep piling up',
  'tasklist-timed-out': 'listing Windows processes timed out',
  'probe-timed-out': 'a no-op launch timed out',
  'probe-failed': 'a no-op launch failed',
  'spawn-failures': 'sessions failed to start for system reasons',
  'impaired-while-idle': 'the agent server is impaired while the processor is idle',
  'lag-while-idle': 'the agent server is lagging while the processor is idle',
};

export function wedgeNoticeItem(input: WedgeNoticeInput, machineLabel: string): WedgeAttentionItem {
  const signs = input.reasons.map((r) => REASON_WORDS[r] ?? r).join('; ');
  const recent = input.recentlyRestarted === true ? ' It was restarted less than 6 hours ago, so another restart is not proposed.' : '';
  const forced = input.forcedDueAt !== null ? ` Its next maintenance window is marked due (${new Date(input.forcedDueAt).toISOString()}), on paper only.` : '';
  return {
    id: `machine-wedge:${input.episodeId}`,
    title: `${machineLabel} looks wedged`,
    summary: `${machineLabel} has shown two separate signs of being stuck for 20 minutes or more: ${signs}.`,
    description:
      `${machineLabel} has shown two separate signs of being stuck for 20 minutes or more: ${signs}.${recent}` +
      `\n\nNothing has been done automatically: wedge restart is in watch-only mode, and the restart button is not built yet. ` +
      `If you are near the machine and it is unresponsive, a restart by hand is the remedy.${forced}` +
      (input.proposal ? `\n\nThe judge proposed: ${input.proposal}. That proposal is recorded only.` : '\n\nNo judge proposal was available; that is recorded too.'),
    category: 'system',
    priority: input.critical ? 'HIGH' : 'NORMAL',
    sourceContext: 'machine-maintenance',
  };
}

export interface WedgeNoticeDeps {
  createAttentionItem: ((item: WedgeAttentionItem) => Promise<unknown>) | null;
  machineLabel: (machineId: string) => string;
}

/** The function the WedgeMonitor is given as `raiseNotice`. */
export function makeWedgeNoticeSender(deps: WedgeNoticeDeps): (input: WedgeNoticeInput) => Promise<WedgeNoticeOutcome> {
  const sent = new Set<string>();
  return async (input) => {
    if (sent.has(input.episodeId)) return 'duplicate';
    if (!deps.createAttentionItem) return 'no-channel';
    const target = deriveTargetKey(input.machineId);
    const adm = wedgeNoticeGov.admitSync(target, { incarnation: input.episodeId, lane: 'job' });
    const sink = adm.outcome === 'allow' ? consumeAdmissionToken(adm.token, 'machine-wedge-notice', { targetKey: target.key }) : null;
    if (adm.outcome !== 'allow' || !sink?.proceed) return 'held-by-governor';
    sent.add(input.episodeId);
    await deps.createAttentionItem(wedgeNoticeItem(input, deps.machineLabel(input.machineId)));
    return 'sent';
  };
}
