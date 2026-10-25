import { describe, expect, it } from 'vitest';
import { parseAttentionLimit } from '../../src/server/routes.js';

describe('parseAttentionLimit', () => {
  it.each(['limit', 'count', 'take', 'pageSize'])('accepts the %s alias', (key) => {
    expect(parseAttentionLimit({ [key]: '2' })).toBe(2);
  });

  it('leaves absent and invalid bounds unbounded', () => {
    expect(parseAttentionLimit({})).toBeUndefined();
    expect(parseAttentionLimit({ limit: '0' })).toBeUndefined();
    expect(parseAttentionLimit({ limit: 'two' })).toBeUndefined();
  });
});
