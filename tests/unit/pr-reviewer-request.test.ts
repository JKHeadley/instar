/**
 * Reviewer helpers used by safe-merge at merge-refusal time, plus the guard that
 * keeps ONE send-time reviewer-request path (src/messaging/prLinkReviewRequest.ts).
 * Echo Bugs 10000002553: PRs 3061 and 3063 both requested the reviewer for PR
 * links at send time; 3061's path was removed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveReviewerLogins,
  requestedReviewerLogins,
  confirmedRequested,
} from '../../scripts/pr-reviewer-request.mjs';

describe('resolveReviewerLogins', () => {
  it('defaults to the repo owner', () => {
    expect(resolveReviewerLogins({ repoOwner: 'JKHeadley', author: 'EchoOfDawn' })).toEqual(['JKHeadley']);
  });
  it('explicit logins beat the owner', () => {
    expect(resolveReviewerLogins({ explicit: ['alice'], repoOwner: 'JKHeadley' })).toEqual(['alice']);
  });
  it('never returns the PR author (case-insensitive)', () => {
    expect(resolveReviewerLogins({ repoOwner: 'JKHeadley', author: 'jkheadley' })).toEqual([]);
    expect(resolveReviewerLogins({ explicit: ['bob', 'Carol'], author: 'carol' })).toEqual(['bob']);
  });
  it('drops invalid logins and duplicates', () => {
    expect(resolveReviewerLogins({ explicit: ['-bad', 'ok', 'OK', '', 'has space'] })).toEqual(['ok']);
  });
  it('returns nothing with no owner and no explicit login', () => {
    expect(resolveReviewerLogins({})).toEqual([]);
  });
});

describe('requested reviewer parsing', () => {
  it('reads logins from a requested_reviewers array', () => {
    expect(requestedReviewerLogins([{ login: 'a' }, null, { id: 1 }, { login: 'b' }])).toEqual(['a', 'b']);
    expect(requestedReviewerLogins(undefined)).toEqual([]);
  });
  it('confirms only the logins the POST response lists', () => {
    expect(confirmedRequested({ requested_reviewers: [{ login: 'JKHeadley' }] }, ['jkheadley', 'x'])).toEqual(['jkheadley']);
    expect(confirmedRequested(JSON.stringify({ requested_reviewers: [] }), ['a'])).toEqual([]);
  });
  it('treats an unparseable 2xx body as success (the request is idempotent)', () => {
    expect(confirmedRequested('not json', ['a'])).toEqual(['a']);
  });
});

describe('one reviewer-request path', () => {
  const root = path.resolve(__dirname, '../..');
  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...filesUnder(p));
      else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  it('only prLinkReviewRequest.ts (send time) and safe-merge.mjs (merge time) POST requested_reviewers', () => {
    const posting = [...filesUnder(path.join(root, 'src')), ...filesUnder(path.join(root, 'scripts'))]
      .filter((f) => {
        const s = fs.readFileSync(f, 'utf8');
        return s.includes('requested_reviewers') && /['"]POST['"]/.test(s);
      })
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .sort();
    expect(posting).toEqual(['scripts/safe-merge.mjs', 'src/messaging/prLinkReviewRequest.ts']);
  });
  it('the removed duplicate send-time check is gone', () => {
    expect(fs.existsSync(path.join(root, 'src/core/PrLinkReviewerCheck.ts'))).toBe(false);
    const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf8');
    expect(routes).not.toMatch(/PrLinkReviewerCheck|checkPrLinkReviewers/);
  });
});
