/**
 * shouldOwnTelegramPoll — pure predicate for the standby-no-poll guard.
 *
 * Both sides of the decision boundary with realistic inputs (Testing Integrity
 * Standard): the DEFAULT must be poll (so no existing single-machine agent
 * changes), and ONLY an explicit `multiMachine.telegramPolling === false`
 * suppresses the poll.
 */
import { describe, it, expect } from 'vitest';
import { shouldOwnTelegramPoll } from '../../../src/lifeline/telegramPollOwnership.js';

describe('shouldOwnTelegramPoll', () => {
  it('DEFAULTS to true when multiMachine is absent (existing single-machine agent → polls)', () => {
    expect(shouldOwnTelegramPoll({})).toBe(true);
  });

  it('DEFAULTS to true when telegramPolling is undefined (multiMachine present, flag unset)', () => {
    expect(shouldOwnTelegramPoll({ multiMachine: {} })).toBe(true);
  });

  it('returns true when telegramPolling is explicitly true (awake/primary machine)', () => {
    expect(shouldOwnTelegramPoll({ multiMachine: { telegramPolling: true } })).toBe(true);
  });

  it('returns FALSE only when telegramPolling is explicitly false (standby suppresses its poll)', () => {
    expect(shouldOwnTelegramPoll({ multiMachine: { telegramPolling: false } })).toBe(false);
  });

  it('tolerates null/undefined config (fail-safe → polls)', () => {
    expect(shouldOwnTelegramPoll(undefined)).toBe(true);
    expect(shouldOwnTelegramPoll(null)).toBe(true);
  });
});
