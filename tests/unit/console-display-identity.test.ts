import { describe, expect, it } from 'vitest';
import { verifiedDisplayName, uniqueNamedChoices } from '../../dashboard/console/display-identity.js';

describe('console display identity', () => {
  it('keeps a known name bound to its routing ID', () => {
    expect(verifiedDisplayName('  Instar dashboard makeover  ', 127504)).toBe('Instar dashboard makeover');
    expect(verifiedDisplayName('SageMind', '237407fc58562c0f0a677f3da1d9c736')).toBe('SageMind');
  });

  it('refuses routing identifiers and generated topic labels as names', () => {
    for (const candidate of ['127504', '4821', 'topic-127504', 'topic 127504', 'Telegram topic 127504', '237407fc', '237407fc…', '237407fc58562c0f0a677f3da1d9c736', 'Agent name unavailable', 'Unnamed agent']) {
      expect(verifiedDisplayName(candidate, 127504)).toBeNull();
    }
  });

  it('excludes missing and duplicate names from action choices', () => {
    expect(uniqueNamedChoices([
      { fp: 'a', name: 'Scout' }, { fp: 'b', name: 'scout' },
      { fp: 'c', name: 'Echo' }, { fp: 'd', name: 'topic-123' },
    ])).toEqual([{ fp: 'c', name: 'Echo' }]);
  });
});
