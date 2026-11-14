/**
 * The status reconciler's open-PR listing reads GitHub in small GraphQL pages. One
 * `gh pr list --limit 1000` call asked for 100 PRs (with every PR's checks) per page; past
 * ~100 open PRs that page timed out on GitHub (HTTP 502) and every pass failed, so the
 * Local Verify queue admitted nothing (2026-11-13, 102 open PRs).
 */
import { describe, expect, it } from 'vitest';
import { buildReconcilerGitHubSeams, OPEN_PR_PAGE_SIZE, OPEN_PRS_QUERY, type GhRunner } from '../../../src/localVerify/reconcilerSeams.js';

const sha = (c: string) => c.repeat(40);

const node = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, headRefOid: sha('a'), baseRefName: 'main', headRefName: `echo/pr-${n}`, isCrossRepository: false,
  author: { __typename: 'User', login: 'EchoOfDawn' },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: 'StatusContext', context: 'instar/local-verify', state: 'PENDING' },
    { __typename: 'CheckRun', name: 'Build', status: 'QUEUED', conclusion: null },
    { __typename: 'CheckRun', name: 'Type Check', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ] } } } }] },
  ...extra,
});
const page = (nodes: unknown[]) => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });

function fakeGh(stdout: string | null): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    return stdout === null ? { ok: false, status: 502, stderr: 'HTTP 502: 502 Bad Gateway' } : { ok: true, stdout };
  };
  return { gh, calls };
}

describe('reconciler listOpenPrs (paged GraphQL)', () => {
  it('asks GitHub for small pages of open PRs on main, following every page', async () => {
    const { gh, calls } = fakeGh(JSON.stringify([page([node(1)])]));
    await buildReconcilerGitHubSeams('JKHeadley/instar', gh).listOpenPrs();
    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args.slice(0, 4)).toEqual(['api', 'graphql', '--paginate', '--slurp']);
    expect(args).toContain('owner=JKHeadley');
    expect(args).toContain('name=instar');
    expect(args).toContain(`query=${OPEN_PRS_QUERY}`);
    expect(args).not.toContain('pr');
    expect(OPEN_PR_PAGE_SIZE).toBeLessThanOrEqual(25);
    expect(OPEN_PRS_QUERY).toContain(`first: ${OPEN_PR_PAGE_SIZE}`);
    expect(OPEN_PRS_QUERY).toContain('states: OPEN');
    expect(OPEN_PRS_QUERY).toContain('baseRefName: "main"');
    // gh --paginate needs the cursor variable and the connection's pageInfo.
    expect(OPEN_PRS_QUERY).toContain('$endCursor: String');
    expect(OPEN_PRS_QUERY).toContain('pageInfo { hasNextPage endCursor }');
  });

  it('joins every page into one list with the same shape gh pr list gave', async () => {
    const { gh } = fakeGh(JSON.stringify([page([node(30), node(29)]), page([node(28)])]));
    const prs = await buildReconcilerGitHubSeams('o/r', gh).listOpenPrs();
    expect(prs?.map((p) => p.number)).toEqual([30, 29, 28]);
    expect(prs?.[0]).toEqual({
      number: 30, headSha: sha('a'), baseRefName: 'main', headRefName: 'echo/pr-30', author: 'EchoOfDawn', isCrossRepository: false,
      rollup: [
        { kind: 'status', context: 'instar/local-verify', state: 'PENDING' },
        // gh pr list reported an unfinished check's conclusion as '' (GraphQL gives null).
        { kind: 'check', name: 'Build', status: 'QUEUED', conclusion: '' },
        { kind: 'check', name: 'Type Check', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      rollupTruncated: false,
    });
  });

  it('reports a bot author as app/<login>, as gh pr list did', async () => {
    const { gh } = fakeGh(JSON.stringify([page([node(5, { author: { __typename: 'Bot', login: 'dependabot' } }), node(6, { author: null })])]));
    const prs = await buildReconcilerGitHubSeams('o/r', gh).listOpenPrs();
    expect(prs?.map((p) => p.author)).toEqual(['app/dependabot', null]);
  });

  it('marks a PR whose checks run past one page as truncated, and a PR with no checks as empty', async () => {
    const many = node(8);
    (many.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo as { hasNextPage: boolean }).hasNextPage = true;
    const none = node(9, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } });
    const { gh } = fakeGh(JSON.stringify([page([many, none])]));
    const prs = await buildReconcilerGitHubSeams('o/r', gh).listOpenPrs();
    expect(prs?.map((p) => [p.number, p.rollupTruncated, p.rollup.length])).toEqual([[8, true, 3], [9, false, 0]]);
  });

  it('is a failed read (null), never a short list, when GitHub fails or a page is bad', async () => {
    const cases: Array<string | null> = [
      null, // HTTP 502
      'not json',
      '[]', // no pages at all
      JSON.stringify([page([node(1)]), { errors: [{ message: 'timeout' }] }]),
      JSON.stringify([page([node(1)]), { data: { repository: null } }]),
      JSON.stringify([page([node(1), { number: 'x' }])]),
    ];
    for (const c of cases) {
      const { gh } = fakeGh(c);
      expect(await buildReconcilerGitHubSeams('o/r', gh).listOpenPrs(), String(c)).toBeNull();
    }
  });

  it('an empty repo is an empty list, not a failure', async () => {
    const { gh } = fakeGh(JSON.stringify([page([])]));
    expect(await buildReconcilerGitHubSeams('o/r', gh).listOpenPrs()).toEqual([]);
  });

  it('a malformed repo name is a failed read and calls nothing', async () => {
    const { gh, calls } = fakeGh(JSON.stringify([page([])]));
    expect(await buildReconcilerGitHubSeams('no-slash', gh).listOpenPrs()).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
