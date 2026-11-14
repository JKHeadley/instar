/**
 * The auto-merger's paged open-PR listing (greenPrOpenPrList).
 *
 * 2026-11-13: the single `gh pr list --limit 100` call got HTTP 502 from GitHub at 60 authored
 * open PRs, every tick failed, and a verified PR sat unmerged. These tests pin the paged read:
 * every page is followed, only the account's own PRs are kept, a failed or unreadable page is a
 * failed listing (never a short list), and each row means the same to mapPr as gh's row did.
 */
import { describe, expect, it } from 'vitest';
import {
  GH_ZERO_TIME, ghRowFromGraphqlPr, listOpenPrRowsPaged, OPEN_PR_LIST_LIMIT, OPEN_PR_LIST_MAX_PAGES, OPEN_PR_LIST_PAGE_SIZE,
  OPEN_PR_LIST_QUERY, type GhExecResult, type GqlOpenPrListNode,
} from '../../src/monitoring/greenPrOpenPrList.js';
import { LIST_PR_JSON_FIELDS, mapPr } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { NO_CHECKS_ROLLUP } from '../../src/monitoring/greenPrLogic.js';

const node = (number: number, login = 'me', over: Partial<GqlOpenPrListNode> = {}): GqlOpenPrListNode => ({
  number, title: `t${number}`, isDraft: false, headRefName: `echo/${number}`, headRefOid: `sha${number}`, baseRefName: 'main',
  mergeable: 'MERGEABLE', reviewDecision: null, createdAt: '2026-11-01T00:00:00Z', isCrossRepository: false,
  labels: { nodes: [{ name: 'merge-throughput' }] }, author: { __typename: 'User', login }, autoMergeRequest: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] }, ...over,
});
const page = (nodes: unknown[], next: string | null, viewer: unknown = 'me', extra: Record<string, unknown> = {}): GhExecResult => ({
  code: 0, stderr: '',
  stdout: JSON.stringify({ data: { viewer: { login: viewer }, repository: { pullRequests: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } }, ...extra }),
});
/** A fake gh that serves pages in order and records the cursor each call carried. */
function pagedGh(pages: GhExecResult[]) {
  const cursors: Array<string | null> = [];
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    cursors.push(args.find((a) => a.startsWith('endCursor='))?.slice('endCursor='.length) ?? null);
    return pages[calls.length - 1] ?? { code: 1, stdout: '', stderr: 'no more pages' };
  };
  return { exec, cursors, calls };
}

describe('listOpenPrRowsPaged', () => {
  it('follows every page with the cursor GitHub returned, keeping oldest-first order', async () => {
    const gh = pagedGh([page([node(1), node(2)], 'c1'), page([node(3)], 'c2'), page([node(4)], null)]);
    const rows = await listOpenPrRowsPaged(gh.exec, 'JKHeadley/instar');
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(gh.cursors).toEqual([null, 'c1', 'c2']);
    expect(gh.calls[0].slice(0, 2)).toEqual(['api', 'graphql']);
    expect(gh.calls[0]).toEqual(expect.arrayContaining(['owner=JKHeadley', 'name=instar', `query=${OPEN_PR_LIST_QUERY}`]));
  });

  it('asks for small pages, oldest first, open PRs on main only', () => {
    expect(OPEN_PR_LIST_PAGE_SIZE).toBeLessThanOrEqual(15);
    expect(OPEN_PR_LIST_QUERY).toContain(`first: ${OPEN_PR_LIST_PAGE_SIZE}`);
    expect(OPEN_PR_LIST_QUERY).toContain('states: OPEN');
    expect(OPEN_PR_LIST_QUERY).toContain('baseRefName: "main"');
    expect(OPEN_PR_LIST_QUERY).toContain('direction: ASC');
  });

  it("keeps only the authenticated account's PRs (the old --author @me)", async () => {
    const gh = pagedGh([page([node(1, 'someone-else'), node(2, 'me'), node(3, 'me', { author: null })], null)]);
    expect((await listOpenPrRowsPaged(gh.exec, 'o/r')).map((r) => r.number)).toEqual([2]);
  });

  it('stops at the 100-PR limit the single call carried', async () => {
    const many = (from: number) => Array.from({ length: 60 }, (_, i) => node(from + i));
    const gh = pagedGh([page(many(1), 'c1'), page(many(61), 'c2'), page([node(999)], null)]);
    const rows = await listOpenPrRowsPaged(gh.exec, 'o/r');
    expect(rows).toHaveLength(OPEN_PR_LIST_LIMIT);
    expect(rows.at(-1)!.number).toBe(100);
    expect(gh.calls).toHaveLength(2);
  });

  it('a failed page fails the whole listing, never a short list', async () => {
    const gh = pagedGh([page([node(1)], 'c1'), { code: 1, stdout: '', stderr: 'HTTP 502: 502 Bad Gateway' }]);
    await expect(listOpenPrRowsPaged(gh.exec, 'o/r')).rejects.toThrow(/gh pr list failed: page 2: HTTP 502/);
  });

  it.each([
    ['GraphQL errors', page([node(1)], null, 'me', { errors: [{ message: 'timeout' }] })],
    ['no viewer login', page([node(1)], null, null)],
    ['a null PR node', page([null], null)],
    ['a missing connection', { code: 0, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'me' }, repository: null } }) }],
    ['unparseable output', { code: 0, stderr: '', stdout: '<html>502</html>' }],
    ['a next page with no cursor', { code: 0, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } }) }],
  ])('%s is a failed listing', async (_name, bad) => {
    const gh = pagedGh([bad]);
    await expect(listOpenPrRowsPaged(gh.exec, 'o/r')).rejects.toThrow(/^gh pr list failed: page 1: /);
    // Refused on the page itself: no further page was asked for.
    expect(gh.calls).toHaveLength(1);
  });

  it('refuses to read past the page cap instead of returning a cut list', async () => {
    let n = 0;
    const exec = async () => page([node(++n, 'someone-else')], `c${n}`);
    await expect(listOpenPrRowsPaged(exec, 'o/r')).rejects.toThrow(/more than/);
    expect(n).toBe(OPEN_PR_LIST_MAX_PAGES);
  });

  it('a repo that is not owner/name fails before any call', async () => {
    const gh = pagedGh([]);
    await expect(listOpenPrRowsPaged(gh.exec, 'instar')).rejects.toThrow(/owner\/name/);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('ghRowFromGraphqlPr — same meaning to mapPr as the gh pr list row', () => {
  const contexts = (nodes: unknown[]) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } } as Partial<GqlOpenPrListNode>);
  const run = (name: string, status: string, conclusion: string | null, completedAt: string | null = '2026-11-13T10:00:00Z') => ({
    __typename: 'CheckRun', name, status, conclusion, startedAt: '2026-11-13T09:50:00Z', completedAt,
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  });

  it('carries exactly the pinned list projection, in order', () => {
    expect(Object.keys(ghRowFromGraphqlPr(node(1)))).toEqual([...LIST_PR_JSON_FIELDS]);
  });

  it('maps the plain fields the merger reads', () => {
    const pr = mapPr(ghRowFromGraphqlPr(node(7, 'me', { isDraft: true, reviewDecision: 'APPROVED', autoMergeRequest: { enabledAt: 't' }, isCrossRepository: true })));
    expect(pr).toMatchObject({
      number: 7, title: 't7', labels: ['merge-throughput'], isDraft: true, headRefName: 'echo/7', headRefOid: 'sha7', baseRefName: 'main',
      reviewDecision: 'APPROVED', createdAt: '2026-11-01T00:00:00Z', mergeable: 'MERGEABLE', autoMergeArmed: true, authorLogin: 'me', isCrossRepository: true,
    });
  });

  it('all workflow checks green reads SUCCESS (the workflow name survives the flattening)', () => {
    expect(mapPr(ghRowFromGraphqlPr(node(1, 'me', contexts([run('Unit', 'COMPLETED', 'SUCCESS')])))).statusRollup).toBe('SUCCESS');
  });

  it('an unfinished check reads PENDING (GraphQL null conclusion becomes gh\'s empty string)', () => {
    const row = ghRowFromGraphqlPr(node(1, 'me', contexts([run('Unit', 'IN_PROGRESS', null, null)])));
    const entry = (row.statusCheckRollup as Array<{ conclusion: string; completedAt: string; startedAt: string }>)[0];
    expect(entry.conclusion).toBe('');
    // gh printed an unset time as Go's zero time, never null.
    expect(entry.completedAt).toBe(GH_ZERO_TIME);
    expect(entry.startedAt).toBe('2026-11-13T09:50:00Z');
    expect(mapPr(row).statusRollup).toBe('PENDING');
  });

  it('a failed check reads FAILURE and is listed with its completion time', () => {
    const pr = mapPr(ghRowFromGraphqlPr(node(1, 'me', contexts([run('Unit', 'COMPLETED', 'SUCCESS'), run('E2E', 'COMPLETED', 'FAILURE')]))));
    expect(pr.statusRollup).toBe('FAILURE');
    expect(pr.failingChecks).toEqual([{ name: 'E2E', completedAt: Date.parse('2026-11-13T10:00:00Z') }]);
  });

  it('only a commit status (no workflow check) still reads as no checks run', () => {
    const pr = mapPr(ghRowFromGraphqlPr(node(1, 'me', contexts([{ __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS', createdAt: '2026-11-13T10:00:00Z' }]))));
    expect(pr.statusRollup).toBe(NO_CHECKS_ROLLUP);
  });

  it('no rollup at all reads as no checks run; a bot author keeps gh\'s app/ prefix', () => {
    const row = ghRowFromGraphqlPr(node(1, 'me', { commits: { nodes: [] }, author: { __typename: 'Bot', login: 'dependabot' } }));
    expect(mapPr(row).statusRollup).toBe(NO_CHECKS_ROLLUP);
    expect(mapPr(row).authorLogin).toBe('app/dependabot');
  });
});
