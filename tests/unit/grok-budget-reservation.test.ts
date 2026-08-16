/**
 * Unit tests — the reviewer budget's RESERVATION lifecycle (round-18).
 *
 * Round-17 added reserve-then-settle so the daily ceiling would hold under
 * concurrency. Executing that path for the first time — in round 18, by a
 * reviewer — found three defects in it, of which the worst is deterministic
 * and needs no concurrency at all to pin:
 *
 *   Every exit BETWEEN admission and settle leaked the reserved slot for the
 *   full 15-minute TTL. The worst leak is the DELIBERATE one: the capacity-shed
 *   branch skips recording precisely so transient host load cannot exhaust the
 *   grok family's day — while the reservation it had already written did
 *   exactly that. Measured: 24 sheds with zero settles closed the ceiling at
 *   `runs: 0`, and the refusal then read "daily-budget-exhausted 0 runs /
 *   0 tokens", which is self-contradicting.
 *
 * The CONCURRENCY half genuinely needs real processes and is carried by
 * CMT-1330. This file is the half that does not, written because "the test is
 * hard" was doing work it should not have been doing: the leak is a plain
 * lifecycle bug, observable single-threaded, and it sat unexercised because the
 * whole area was filed under "needs concurrency".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reserveGrokBudgetSlotForTest,
  reserveAndReleaseGrokSlotForTest,
  GROK_REVIEWER_DAILY_MAX_RUNS,
} from '../../src/core/crossModelReviewer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let home: string;
let savedHome: string | undefined;

function ledger(): { runs: number; reservations?: unknown[] } | null {
  const p = path.join(home, '.instar', 'grok-reviewer-budget.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-reserve-'));
  fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome;
  SafeFsExecutor.safeRmSync(home, {
    recursive: true,
    force: true,
    operation: 'tests/unit/grok-budget-reservation.test.ts:afterEach',
  });
});

describe('grok reviewer budget — reservation lifecycle', () => {
  it('a reservation without a settle HOLDS a ceiling slot', () => {
    // This is the mechanism, asserted plainly: reservations are what make the
    // ceiling hold under concurrency, so they must occupy space.
    expect(reserveGrokBudgetSlotForTest()).toBe('ok');
    const after = ledger();
    expect(after?.runs).toBe(0);
    expect((after?.reservations ?? []).length).toBe(1);
  });

  it('RELEASE returns the slot without counting a run — the leak fix', () => {
    // The capacity-shed path deliberately does not record (a shed spawned no
    // child and burned zero tokens). Before round-18 it also did not release,
    // so the slot stayed held and transient host load could close the family's
    // day at zero runs — the precise outcome the no-record rule exists to
    // prevent.
    expect(reserveAndReleaseGrokSlotForTest()).toBe('released');
    const after = ledger();
    expect((after?.reservations ?? []).length).toBe(0);
    // And crucially it must NOT have counted a run: a release is not a spend.
    expect(after?.runs).toBe(0);
  });

  it('repeated reserve-then-release never exhausts the ceiling', () => {
    // The measured failure was 24 unreleased reservations closing the ceiling.
    // Run past that count with releases and the family must stay open.
    for (let i = 0; i < GROK_REVIEWER_DAILY_MAX_RUNS + 2; i++) {
      expect(reserveAndReleaseGrokSlotForTest(), `iteration ${i}`).toBe('released');
    }
    expect(reserveGrokBudgetSlotForTest()).toBe('ok');
  });

  it('CONTROL: reservations WITHOUT release still exhaust it', () => {
    // Without this control the three assertions above would be satisfied by a
    // reservation system that never reserves anything at all. This is the
    // measured defect reproduced deliberately, as the proof that reservations
    // are load-bearing rather than decorative.
    for (let i = 0; i < GROK_REVIEWER_DAILY_MAX_RUNS; i++) {
      expect(reserveGrokBudgetSlotForTest()).toBe('ok');
    }
    expect(reserveGrokBudgetSlotForTest()).toBe('exhausted');
    expect(ledger()?.runs).toBe(0); // exhausted at ZERO settled runs
  });
});
