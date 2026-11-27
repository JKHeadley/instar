import { describe, it, expect } from 'vitest';
import { seatNotMovedReason } from '../../src/core/poolTransferReason.js';

describe('seatNotMovedReason', () => {
  it('a timed-out drain does not claim the seat stayed', () => {
    const r = seatNotMovedReason({ attempted: true, ok: false, reason: 'status-408' });
    expect(r).toContain('may still land');
    expect(r).not.toContain('did not move');
  });
  it('a real drain failure still says so', () => {
    expect(seatNotMovedReason({ attempted: true, ok: false, reason: 'status-500' })).toContain('did not move');
  });
  it('no drain attempted names the ownership', () => {
    expect(seatNotMovedReason({ attempted: false })).toContain('ownership did not transfer');
  });
});
