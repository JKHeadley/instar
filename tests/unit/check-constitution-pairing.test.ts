/**
 * Rule 119: every change to either book names its counterpart or says why it has none.
 * The checker judges existence only, so both sides of each existence question are here.
 * Whether a wording matches, or a "none" is honest, is not testable here by design.
 */

import { describe, it, expect } from 'vitest';
import {
  INSTAR,
  INSTAR_2,
  WINDOW_MS,
  touchesBook,
  parseDeclaration,
  pairProblem,
  checkPr,
  classifyMerged,
  runDaily,
  summarize,
  pairingRefusal,
} from '../../scripts/check-constitution-pairing.mjs';

const real = { state: 'OPEN', baseRefName: 'main', files: ['docs/01-the-rules.md'] };
const pairLine = `Body text.\nConstitution counterpart: ${INSTAR_2}#190\n`;

describe('touchesBook', () => {
  it('covers each book and nothing near it', () => {
    expect(touchesBook(INSTAR, ['docs/STANDARDS-REGISTRY.md'])).toBe(true);
    expect(touchesBook(INSTAR_2, ['docs/rules/91-x.md'])).toBe(true);
    expect(touchesBook(INSTAR_2, ['docs/00-the-purpose.md'])).toBe(true);
    expect(touchesBook(INSTAR, ['docs/STANDARDS-DIRECTION-GUARD.md', 'docs/01-the-rules.md'])).toBe(false);
    expect(touchesBook(INSTAR_2, ['docs/01-the-rules.changelog.md'])).toBe(false);
    expect(touchesBook('someone/else', ['docs/STANDARDS-REGISTRY.md'])).toBe(false);
  });
});

describe('parseDeclaration', () => {
  it('reads a pair, and none with a reason', () => {
    expect(parseDeclaration(pairLine)).toEqual({ kind: 'pair', repo: INSTAR_2, number: 190 });
    expect(parseDeclaration('Constitution counterpart: none: code path only')).toEqual({ kind: 'none', reason: 'code path only' });
  });

  it('a CRLF body reads the same', () => {
    expect(parseDeclaration(`x\r\nConstitution counterpart: ${INSTAR}#7\r\ny`)).toEqual({ kind: 'pair', repo: INSTAR, number: 7 });
  });

  it('refuses a bare none, an unreadable value, two lines, and no line', () => {
    expect(parseDeclaration('Constitution counterpart: none:').kind).toBe('malformed');
    expect(parseDeclaration('Constitution counterpart: #190').kind).toBe('malformed');
    expect(parseDeclaration(`${pairLine}Constitution counterpart: none: x`).kind).toBe('malformed');
    expect(parseDeclaration('nothing here').kind).toBe('missing');
    expect(parseDeclaration(null).kind).toBe('missing');
  });
});

describe('pairProblem', () => {
  const d = parseDeclaration(pairLine);

  it('passes a real pair, open or merged', () => {
    expect(pairProblem(INSTAR, d, real)).toBeNull();
    expect(pairProblem(INSTAR, d, { ...real, state: 'MERGED' })).toBeNull();
  });

  it('fails the same repo, a non-main target, a closed PR, and one touching no book', () => {
    expect(pairProblem(INSTAR_2, d, real)).toMatch(/names/);
    expect(pairProblem(INSTAR, d, { ...real, baseRefName: 'echo/x' })).toMatch(/targets/);
    expect(pairProblem(INSTAR, d, { ...real, state: 'CLOSED' })).toMatch(/closed/);
    expect(pairProblem(INSTAR, d, { ...real, files: ['README.md'] })).toMatch(/no book/);
  });
});

describe('checkPr', () => {
  it('passes a stated none without any read', () => {
    const r = checkPr(INSTAR, 'Constitution counterpart: none: path only', () => {
      throw new Error('must not read');
    });
    expect(r.result).toBe('pass');
  });

  it('refuses a missing line', () => {
    expect(checkPr(INSTAR, 'no line', () => real).result).toBe('refuse');
  });

  it('a failed read is unknown, never a pass', () => {
    const r = checkPr(INSTAR, pairLine, () => {
      throw new Error('502');
    });
    expect(r.result).toBe('unknown');
    expect(r.detail).toContain('502');
  });

  it('passes when the counterpart is real, refuses when it is not', () => {
    expect(checkPr(INSTAR, pairLine, () => real).result).toBe('pass');
    expect(checkPr(INSTAR, pairLine, () => ({ ...real, files: [] })).result).toBe('refuse');
  });
});

describe('classifyMerged', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const recent = new Date(now - 1000).toISOString();
  const old = new Date(now - WINDOW_MS - 1000).toISOString();
  const base = { repo: INSTAR, now, mergedAt: recent };

  it('every class', () => {
    expect(classifyMerged({ ...base, body: pairLine, counterpart: { ...real, state: 'MERGED' } }).class).toBe('paired');
    expect(classifyMerged({ ...base, body: 'Constitution counterpart: none: x', counterpart: null }).class).toBe('declared-none');
    expect(classifyMerged({ ...base, body: pairLine, counterpart: real }).class).toBe('waiting');
    expect(classifyMerged({ ...base, mergedAt: old, body: pairLine, counterpart: real }).class).toBe('overdue');
    expect(classifyMerged({ ...base, body: 'no line', counterpart: null }).class).toBe('drift');
  });

  it('a counterpart closed unmerged, or touching no book, is drift even inside the window', () => {
    expect(classifyMerged({ ...base, body: pairLine, counterpart: { ...real, state: 'CLOSED' } }).class).toBe('drift');
    expect(classifyMerged({ ...base, body: pairLine, counterpart: { ...real, files: ['README.md'] } }).class).toBe('drift');
  });

  it('a merged counterpart past the window is still paired', () => {
    expect(classifyMerged({ ...base, mergedAt: old, body: pairLine, counterpart: { ...real, state: 'MERGED' } }).class).toBe('paired');
  });
});

describe('runDaily', () => {
  const fakes = (overrides: { commitsOnPath?: (path: string) => { sha: string }[]; pullsFor?: (sha: string) => unknown[] }) => {
    const ghFn = (args: string[]) => {
      const path = args[1];
      const pulls = path.match(/commits\/(\w+)\/pulls$/);
      if (pulls) return JSON.stringify(overrides.pullsFor?.(pulls[1]) ?? []);
      if (/commits\/\w+$/.test(path)) return JSON.stringify({ commit: { committer: { date: '2026-11-01T00:00:00Z' } } });
      const pr = path.match(/pulls\/(\d+)$/);
      if (pr) return JSON.stringify({ state: 'closed', merged_at: '2026-11-02T00:00:00Z', base: { ref: 'main' }, body: 'no line' });
      throw new Error(`unexpected ${path}`);
    };
    const ghPagesFn = (path: string) =>
      path.includes('/files') ? [{ filename: 'docs/STANDARDS-REGISTRY.md' }] : (overrides.commitsOnPath?.(path) ?? []);
    return { ghFn, ghPagesFn, since: { [INSTAR]: 'aaa', [INSTAR_2]: 'bbb' }, now: Date.parse('2026-11-05T00:00:00Z') };
  };

  it('nothing changed reads as zero of every class, having looked', () => {
    expect(summarize(runDaily(fakes({})))).toEqual({ paired: 0, 'declared-none': 0, waiting: 0, overdue: 0, drift: 0, 'no-pr': 0 });
  });

  it('several commits from one PR give one row', () => {
    const report = runDaily(fakes({
      commitsOnPath: (p) => (p.includes('instar/commits') && p.includes('REGISTRY') ? [{ sha: 'c1' }, { sha: 'c2' }] : []),
      pullsFor: () => [{ number: 9, merged_at: '2026-11-02T00:00:00Z' }],
    }));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ pr: 9, class: 'drift' });
  });

  it('a commit with no merged PR is no-pr, with its sha', () => {
    const report = runDaily(fakes({
      commitsOnPath: (p) => (p.includes('instar/commits') && p.includes('REGISTRY') ? [{ sha: 'c1' }] : []),
      pullsFor: () => [],
    }));
    expect(report.noPr).toEqual([{ repo: INSTAR, sha: 'c1' }]);
  });

  it('the baseline commit itself is not audited', () => {
    const report = runDaily(fakes({
      commitsOnPath: (p) => (p.includes('instar/commits') && p.includes('REGISTRY') ? [{ sha: 'aaa' }] : []),
    }));
    expect(report.rows).toHaveLength(0);
    expect(report.noPr).toHaveLength(0);
  });

  it('a line naming a PR that does not exist is one row of drift, not an unfinished run', () => {
    const f = fakes({
      commitsOnPath: (p) => (p.includes('instar/commits') && p.includes('REGISTRY') ? [{ sha: 'c1' }] : []),
      pullsFor: () => [{ number: 9, merged_at: '2026-11-02T00:00:00Z' }],
    });
    const ghFn = (args: string[]) => {
      if (args[1].endsWith('pulls/9')) return JSON.stringify({ state: 'closed', merged_at: '2026-11-02T00:00:00Z', base: { ref: 'main' }, body: pairLine });
      if (args[1].endsWith('pulls/190')) throw new Error('gh: Not Found (HTTP 404)');
      return f.ghFn(args);
    };
    const report = runDaily({ ...f, ghFn });
    expect(report.rows[0]).toMatchObject({ pr: 9, class: 'drift' });
  });

  it('a failed read throws rather than reporting a clean run', () => {
    const f = fakes({});
    expect(() => runDaily({ ...f, ghPagesFn: () => { throw new Error('403'); } })).toThrow('403');
  });
});

describe('pairingRefusal', () => {
  const pr = (over: object) => () => ({ number: 1, state: 'OPEN', baseRefName: 'main', body: '', files: ['docs/STANDARDS-REGISTRY.md'], ...over });

  it('a repository with no book is a no-op, without reading', () => {
    expect(pairingRefusal('someone/else', 1, () => { throw new Error('must not read'); })).toBeNull();
  });

  it('a PR touching no book passes', () => {
    expect(pairingRefusal(INSTAR, 1, pr({ files: ['src/a.ts'] }))).toBeNull();
  });

  it('a book change with no line is refused and says how to clear it', () => {
    const r = pairingRefusal(INSTAR, 1, pr({}));
    expect(r?.result).toBe('refused:constitution-counterpart');
    expect(r?.state).toBe('refuse');
    expect(r?.message).toContain('Constitution counterpart:');
  });

  it('a stated none passes', () => {
    expect(pairingRefusal(INSTAR, 1, pr({ body: 'Constitution counterpart: none: path only' }))).toBeNull();
  });

  it('an unreadable PR refuses as unknown rather than passing', () => {
    const r = pairingRefusal(INSTAR, 1, () => { throw new Error('502'); });
    expect(r?.state).toBe('unread');
    expect(r?.message).not.toContain('Add one line');
  });

  it('a counterpart that cannot be read refuses as unknown', () => {
    const read = (repo: string) => {
      if (repo === INSTAR_2) throw new Error('502');
      return { number: 1, state: 'OPEN', baseRefName: 'main', body: pairLine, files: ['docs/STANDARDS-REGISTRY.md'] };
    };
    expect(pairingRefusal(INSTAR, 1, read)?.state).toBe('unknown');
  });
});
