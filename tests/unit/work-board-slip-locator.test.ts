import { describe, expect, it } from 'vitest';
import { parseWorkBoardSlipReviewUrl, workBoardSlipReviewUrl } from '../../src/core/workBoardSlipLocator.js';

const slipId = '11111111-2222-4333-8444-555555555555';
const origin = 'https://agent.test';
const url = 'https://instar.sh/link/work-board-slip#v=1&origin=https%3A%2F%2Fagent.test&slip=11111111-2222-4333-8444-555555555555';

describe('Work Board slip locator', () => {
  it('generates the canonical locator and maps back to the exact paired origin and slip', () => {
    expect(workBoardSlipReviewUrl(origin, slipId)).toBe(url);
    expect(workBoardSlipReviewUrl(`${origin}/`, slipId)).toBe(url);
    expect(parseWorkBoardSlipReviewUrl(url)).toEqual({ agentOrigin: origin, slipId });
  });

  it.each(['http://agent.test', 'https://user@agent.test', 'https://agent.test/path', 'https://agent.test/?a=b', 'https://agent.test/#secret'])(
    'refuses a non-origin target', (target) => { expect(workBoardSlipReviewUrl(target, slipId)).toBeNull(); },
  );

  it.each([
    `${url}&slip=${slipId}`,
    `${url}&secret=opaque`,
    url.replace('instar.sh', 'instar.sh.example.test'),
    url.replace('v=1', 'v=2'),
    url.replace('#', '?'),
    url.replace('https%3A', 'http%3A'),
  ])('refuses a changed locator', (input) => { expect(parseWorkBoardSlipReviewUrl(input)).toBeNull(); });
});
