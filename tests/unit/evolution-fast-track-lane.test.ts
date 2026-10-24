/**
 * Tier 1 unit tests — the evolution fast-track lane (PROP-969, Dawn cross-pollination).
 *
 * Covers EvolutionManager.getFastTrackItems() and getSessionBrief(): the
 * in-session half of overdue-action handling. Both sides of every decision
 * boundary are exercised, because the whole value of the lane is that it fires
 * when it should and stays quiet when it should not — a surfacing block that
 * cries wolf gets skipped, and one that never fires is indistinguishable from
 * a dead one.
 *
 * Real EvolutionManager over a real tmpdir state file, no mocks (repo policy).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ActionItem } from '../../src/core/types.js';

const HOUR = 3_600_000;

let dir: string;
let evolution: EvolutionManager;

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * HOUR).toISOString();
}

/** Where EvolutionManager keeps the action queue under a given stateDir. */
function actionQueuePath(): string {
  return path.join(dir, 'state', 'evolution', 'action-queue.json');
}

/** Create an action, then force the fields addAction() does not accept directly. */
function seed(input: {
  title: string;
  dueBy?: string;
  tags?: string[];
  status?: ActionItem['status'];
  completedAt?: string;
  context?: string;
  priority?: ActionItem['priority'];
}): ActionItem {
  const created = evolution.addAction({
    title: input.title,
    description: `${input.title} — seeded by the fast-track lane test`,
    priority: input.priority ?? 'high',
    ...(input.dueBy ? { dueBy: input.dueBy } : { followThroughOptOutReason: 'test fixture with no deadline' }),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.context ? { source: { context: input.context } } : {}),
  });
  if (input.status && input.status !== created.status) {
    evolution.updateAction(created.id, { status: input.status });
  }
  if (input.completedAt) {
    // completedAt is stamped by updateAction; the test needs a specific instant.
    const file = actionQueuePath();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = state.actions.find((a: ActionItem) => a.id === created.id);
    row.completedAt = input.completedAt;
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  }
  return created;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-fast-track-'));
  evolution = new EvolutionManager({ stateDir: dir });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/evolution-fast-track-lane.test.ts',
  });
});

describe('getFastTrackItems — who is in the lane', () => {
  it('auto-enrolls an overdue action that nobody remembered to tag', () => {
    seed({ title: 'Land the dissent ledger', dueBy: hoursFromNow(-52) });

    const items = evolution.getFastTrackItems();

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('overdue');
    expect(items[0].marked).toBe(false);
    expect(items[0].hoursOverdue).toBe(52);
    expect(items[0].hoursRemaining).toBeUndefined();
  });

  it('leaves an untagged action alone while its deadline is still ahead', () => {
    seed({ title: 'Ship the rollout registry', dueBy: hoursFromNow(6) });

    expect(evolution.getFastTrackItems()).toHaveLength(0);
  });

  it('surfaces a tagged action before its deadline — the opt-in pre-nag', () => {
    seed({ title: 'Flip the shadow gate', dueBy: hoursFromNow(6), tags: ['fast-track'] });

    const items = evolution.getFastTrackItems();

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('in-window');
    expect(items[0].marked).toBe(true);
    expect(items[0].hoursRemaining).toBe(6);
    expect(items[0].hoursOverdue).toBeUndefined();
  });

  it('keeps an in_progress overdue action in the lane — started is not resolved', () => {
    seed({ title: 'Half-built migration', dueBy: hoursFromNow(-3), status: 'in_progress' });

    expect(evolution.getFastTrackItems().map(i => i.status)).toEqual(['in_progress']);
  });

  it('drops an action once it is completed or cancelled', () => {
    seed({ title: 'Already done', dueBy: hoursFromNow(-9), status: 'completed' });
    seed({ title: 'Dropped on purpose', dueBy: hoursFromNow(-9), status: 'cancelled' });

    expect(evolution.getFastTrackItems()).toHaveLength(0);
  });

  it('ignores an action with no deadline — that population belongs to the resurfacer', () => {
    seed({ title: 'Undated commitment' });

    expect(evolution.getFastTrackItems()).toHaveLength(0);
  });

  it('skips an unparseable dueBy instead of throwing or reporting NaN hours', () => {
    const created = seed({ title: 'Corrupt deadline', dueBy: hoursFromNow(-5) });
    const file = actionQueuePath();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.actions.find((a: ActionItem) => a.id === created.id).dueBy = 'next Tuesday-ish';
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    expect(evolution.getFastTrackItems()).toHaveLength(0);
  });

  it('carries the blocking reason from source.context so the nag says why', () => {
    seed({
      title: 'Port the repetition guard',
      dueBy: hoursFromNow(-1),
      context: 'the hook never fires on Bash writes',
    });

    expect(evolution.getFastTrackItems()[0].blocking).toBe('the hook never fires on Bash writes');
  });

  it('omits blocking rather than inventing one when no context was recorded', () => {
    seed({ title: 'No reason given', dueBy: hoursFromNow(-1) });

    expect(evolution.getFastTrackItems()[0].blocking).toBeUndefined();
  });

  it('leads with the longest-ignored row, then the soonest deadline ahead', () => {
    seed({ title: 'overdue by a little', dueBy: hoursFromNow(-2) });
    seed({ title: 'overdue by a lot', dueBy: hoursFromNow(-200) });
    seed({ title: 'due later', dueBy: hoursFromNow(48), tags: ['fast-track'] });
    seed({ title: 'due soon', dueBy: hoursFromNow(2), tags: ['fast-track'] });

    expect(evolution.getFastTrackItems().map(i => i.title)).toEqual([
      'overdue by a lot',
      'overdue by a little',
      'due soon',
      'due later',
    ]);
  });
});

describe('getSessionBrief — what the hook prints', () => {
  it('prints nothing at all when the lane is empty', () => {
    seed({ title: 'Comfortably ahead', dueBy: hoursFromNow(100) });

    const brief = evolution.getSessionBrief();

    expect(brief.lines).toEqual([]);
    expect(brief.overdueCount).toBe(0);
    expect(brief.inWindowCount).toBe(0);
  });

  it('separates "nothing overdue" from "nothing dated" via datedPendingCount', () => {
    const empty = evolution.getSessionBrief();
    expect(empty.overdueCount).toBe(0);
    expect(empty.datedPendingCount).toBe(0);

    seed({ title: 'Has a deadline, still has time', dueBy: hoursFromNow(100) });

    const populated = evolution.getSessionBrief();
    expect(populated.overdueCount).toBe(0);
    expect(populated.datedPendingCount).toBe(1);
  });

  it('names the overdue count and the id in the rendered lines', () => {
    const created = seed({ title: 'Land the dissent ledger', dueBy: hoursFromNow(-52) });

    const brief = evolution.getSessionBrief();

    expect(brief.lines[0]).toContain('1 OVERDUE');
    expect(brief.lines[1]).toContain(created.id);
    expect(brief.lines[1]).toContain('OVERDUE 52h');
    expect(brief.lines.join('\n')).toContain('re-surfaces this block next session');
  });

  it('caps the printed rows but keeps the counts whole and says where the rest are', () => {
    for (let i = 0; i < 8; i += 1) {
      seed({ title: `overdue ${i}`, dueBy: hoursFromNow(-10 - i) });
    }

    const brief = evolution.getSessionBrief();

    expect(brief.overdueCount).toBe(8);
    expect(brief.items).toHaveLength(8);
    const rowLines = brief.lines.filter(l => l.startsWith('  [OVERDUE'));
    expect(rowLines).toHaveLength(5);
    expect(brief.lines.join('\n')).toContain('+3 more — GET /evolution/session-brief');
  });

  it('reports no follow-through rate at all before any dated action has completed', () => {
    seed({ title: 'Still open', dueBy: hoursFromNow(-4) });

    const brief = evolution.getSessionBrief();

    expect(brief.onTimeRate).toBeNull();
    expect(brief.lines.join('\n')).not.toContain('follow-through');
  });

  it('counts a deadline met on the dot as met, and a late one as missed', () => {
    const due = hoursFromNow(-48);
    seed({ title: 'done exactly on time', dueBy: due, status: 'completed', completedAt: due });
    seed({ title: 'done late', dueBy: hoursFromNow(-48), status: 'completed', completedAt: hoursFromNow(-2) });
    seed({ title: 'done early', dueBy: hoursFromNow(-48), status: 'completed', completedAt: hoursFromNow(-72) });
    seed({ title: 'still open and overdue', dueBy: hoursFromNow(-6) });

    const brief = evolution.getSessionBrief();

    expect(brief.onTimeRate).toEqual({ met: 2, total: 3, rate: 0.67 });
    expect(brief.lines.join('\n')).toContain('deadline follow-through so far: 2/3 (67%)');
  });

  it('excludes a completed action that never carried a deadline from the rate', () => {
    seed({ title: 'undated and done', status: 'completed' });
    seed({ title: 'open and overdue', dueBy: hoursFromNow(-6) });

    expect(evolution.getSessionBrief().onTimeRate).toBeNull();
  });
});
