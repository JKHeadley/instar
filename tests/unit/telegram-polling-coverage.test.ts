import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { TelegramPollingCoverage } from '../../src/threadline/TelegramPollingCoverage.js';

it('only accepts empty results for the current generation and cursor', () => {
  const db = new Database(':memory:');
  try {
    const gate = new TelegramPollingCoverage(db);
    const previous = gate.beginCatchUp(10);
    const current = gate.beginCatchUp(11);
    expect(gate.observeResult(previous, 0)).toBe(false);
    expect(gate.observeResult({ ...current, cursor: 10 }, 0)).toBe(false);
    expect(gate.observeResult(current, 1)).toBe(false);
    expect(gate.observeResult(current, 0)).toBe(false);
    const drained = gate.beginCatchUp(12);
    expect(gate.observeResult(drained, 0)).toBe(true);
    expect(gate.observeResult(drained, 0)).toBe(false);

    const pending = gate.beginCatchUp(13);
    gate.close();
    expect(gate.observeResult(pending, 0)).toBe(false);
  } finally {
    db.close();
  }
});
