/**
 * The first-run triage list (docs/specs/chief-of-staff-topic.md, Migration → "First run (one time): triage"):
 * deterministic recommendations from the record's own facts, with the floors — a record that needs the
 * owner or was touched recently is never archived; archive needs a long quiet AND no blockers; an
 * unreadable last-touch is a review, never an archive. The markdown is ordered keep → review → archive.
 */
import { describe, it, expect } from 'vitest';
import { buildTriage, triageInitiative } from '../../src/core/ChiefOfStaffTriage.js';

const NOW = new Date('2026-11-10T00:00:00Z');
const d = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('triageInitiative', () => {
  it('needs-you ⇒ keep, whatever the age; recent ⇒ keep with the repo named; old + unblocked ⇒ archive; old + blocked ⇒ review; unreadable time ⇒ review', () => {
    expect(triageInitiative({ id: 'a', title: 'A', status: 'active', lastTouchedAt: d(90), needsUser: true, needsUserReason: 'pick a name' }, NOW)).toMatchObject({ recommendation: 'keep', reason: 'needs you: pick a name' });
    expect(triageInitiative({ id: 'b', title: 'B', status: 'active', lastTouchedAt: d(3), description: 'Ship it', links: [{ url: 'https://github.com/o/r/pull/5' }] }, NOW)).toMatchObject({ recommendation: 'keep', reason: 'touched 3 days ago; lands in o/r', goalDraft: 'Ship it', linkedRepos: ['o/r'] });
    expect(triageInitiative({ id: 'c', title: 'C', status: 'active', lastTouchedAt: d(60) }, NOW)).toMatchObject({ recommendation: 'archive', ageDays: 60 });
    expect(triageInitiative({ id: 'd', title: 'D', status: 'active', lastTouchedAt: d(60), blockers: ['waiting on vendor'] }, NOW)).toMatchObject({ recommendation: 'review' });
    expect(triageInitiative({ id: 'e', title: 'E', status: 'active', lastTouchedAt: d(20) }, NOW)).toMatchObject({ recommendation: 'review', reason: 'untouched for 20 days' });
    expect(triageInitiative({ id: 'f', title: 'F', status: 'active', lastTouchedAt: 'garbage' }, NOW)).toMatchObject({ recommendation: 'review', ageDays: null });
  });
  it('the floors are owner-tunable: keepWithinDays / archiveAfterDays', () => {
    expect(triageInitiative({ id: 'g', title: 'G', status: 'active', lastTouchedAt: d(20) }, NOW, { keepWithinDays: 30 }).recommendation).toBe('keep');
    expect(triageInitiative({ id: 'h', title: 'H', status: 'active', lastTouchedAt: d(20) }, NOW, { archiveAfterDays: 10 }).recommendation).toBe('archive');
  });
});

describe('buildTriage', () => {
  it('orders keep → review → archive, counts each, escapes table cells, and never writes anything', () => {
    const list = buildTriage([
      { id: '1', title: 'Old | pipe', status: 'active', lastTouchedAt: d(70) },
      { id: '2', title: 'Fresh', status: 'active', lastTouchedAt: d(1) },
      { id: '3', title: 'Quiet', status: 'active', lastTouchedAt: d(25) },
    ], NOW);
    expect(list.rows.map((r) => r.id)).toEqual(['2', '3', '1']);
    expect(list.counts).toEqual({ keep: 1, review: 1, archive: 1 });
    expect(list.markdown).toContain('## Keep — track with a drafted binding (1)');
    expect(list.markdown).toContain('Old \\| pipe');
    expect(list.markdown).toContain('Nothing here has been changed');
  });
  it('an empty tracker yields a list with no sections and zero counts', () => {
    const list = buildTriage([], NOW);
    expect(list.counts).toEqual({ keep: 0, review: 0, archive: 0 });
    expect(list.markdown).not.toContain('## ');
  });
});
