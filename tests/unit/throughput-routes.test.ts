import { describe, expect, it } from 'vitest';
import { buildThroughputSeries, pacificDay } from '../../src/server/throughputRoutes.js';

describe('throughput series contract', () => {
  it('computes prototype-compatible author metrics and index', async () => {
    const graphql = async () => ({
      search: {
        issueCount: 2,
        nodes: [
          {
            number: 1, title: 'Feature', author: { login: 'JKHeadley' },
            createdAt: '2026-07-20T12:00:00Z', mergedAt: '2026-07-21T12:00:00Z',
            additions: 80, deletions: 20,
            reviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] },
            commits: { totalCount: 3 },
          },
          {
            number: 2, title: 'Revert fix', author: { login: 'EchoOfDawn' },
            createdAt: '2026-07-22T00:00:00Z', mergedAt: '2026-07-22T12:00:00Z',
            additions: 10, deletions: 10,
            reviews: { nodes: [] },
            commits: { totalCount: 1 },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await buildThroughputSeries({
      days: 7,
      now: new Date('2026-07-24T00:00:00Z'),
      graphql,
    });
    expect(result.rows[0].authors.codey).toMatchObject({ merges: 1, medianLatencyH: 24, reworkLoops: 1, medianPushIters: 3, medianLoc: 100 });
    expect(result.rows[1].authors.echo).toMatchObject({ merges: 1, medianLatencyH: 12, reverts: 1 });
    expect(result.rows.map(r => r.team.index)).toEqual([55, 59.9]);
    expect(result.weights).toEqual({ velocity: .4, speed: .2, quality: .25, output: .15 });
  });

  it('paginates the direct GraphQL search without a gh subprocess', async () => {
    const cursors: Array<string | null> = [];
    const graphql = async (_query: string, variables: Record<string, unknown>) => {
      cursors.push((variables.cursor as string | null) ?? null);
      return variables.cursor == null
        ? {
            search: {
              issueCount: 1,
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: 'page-2' },
            },
          }
        : {
            search: {
              issueCount: 1,
              nodes: [{
                number: 3, title: 'Feature', author: { login: 'JKHeadley' },
                createdAt: '2026-07-22T00:00:00Z', mergedAt: '2026-07-23T00:00:00Z',
                additions: 1, deletions: 1, reviews: { nodes: [] }, commits: { totalCount: 1 },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
    };
    const result = await buildThroughputSeries({
      days: 7,
      now: new Date('2026-07-24T00:00:00Z'),
      graphql,
    });
    expect(cursors).toEqual([null, 'page-2']);
    expect(result.rows).toHaveLength(1);
  });

  it('fails closed when GitHub Search reports more than its 1,000-result API cap', async () => {
    await expect(buildThroughputSeries({
      days: 30,
      now: new Date('2026-07-24T00:00:00Z'),
      graphql: async () => ({
        search: {
          issueCount: 1_001,
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: 'opaque' },
        },
      }),
    })).rejects.toThrow('github-throughput-result-cap-exceeded');
  });

  it('fails closed when the fetched node count does not match issueCount', async () => {
    await expect(buildThroughputSeries({
      days: 7,
      now: new Date('2026-07-24T00:00:00Z'),
      graphql: async () => ({
        search: {
          issueCount: 1,
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    })).rejects.toThrow('github-throughput-result-truncated');
  });
});

describe('Pacific throughput day', () => {
  it('uses PDT around the summer UTC boundary', () => {
    expect(pacificDay('2026-07-01T06:59:59Z')).toBe('2026-06-30');
    expect(pacificDay('2026-07-01T07:00:00Z')).toBe('2026-07-01');
  });

  it('uses PST around the winter UTC boundary', () => {
    expect(pacificDay('2026-01-01T07:59:59Z')).toBe('2025-12-31');
    expect(pacificDay('2026-01-01T08:00:00Z')).toBe('2026-01-01');
  });
});
