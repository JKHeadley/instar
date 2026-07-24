import { describe, expect, it } from 'vitest';
import { buildThroughputSeries } from '../../src/server/throughputRoutes.js';

describe('throughput series contract', () => {
  it('computes prototype-compatible author metrics and index', async () => {
    const prs = [
      { number: 1, title: 'Feature', author: { login: 'JKHeadley' }, createdAt: '2026-07-20T12:00:00Z', mergedAt: '2026-07-21T12:00:00Z', additions: 80, deletions: 20 },
      { number: 2, title: 'Revert fix', author: { login: 'EchoOfDawn' }, createdAt: '2026-07-22T00:00:00Z', mergedAt: '2026-07-22T12:00:00Z', additions: 10, deletions: 10 },
    ];
    const run = async (args: string[]) => args[0] === 'pr'
      ? { code: 0, stderr: '', stdout: JSON.stringify(prs) }
      : { code: 0, stderr: '', stdout: JSON.stringify({ data: { repository: {
          p1: { reviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] }, commits: { totalCount: 3 } },
          p2: { reviews: { nodes: [] }, commits: { totalCount: 1 } },
        } } }) };
    const result = await buildThroughputSeries({ days: 7, now: new Date('2026-07-24T00:00:00Z'), run });
    expect(result.rows[0].authors.codey).toMatchObject({ merges: 1, medianLatencyH: 24, reworkLoops: 1, medianPushIters: 3, medianLoc: 100 });
    expect(result.rows[1].authors.echo).toMatchObject({ merges: 1, medianLatencyH: 12, reverts: 1 });
    expect(result.rows.map(r => r.team.index)).toEqual([55, 59.9]);
    expect(result.weights).toEqual({ velocity: .4, speed: .2, quality: .25, output: .15 });
  });
});
