import { describe, expect, it } from 'vitest';
import {
  compareProjectLists,
  type AuthorizedProjectListSnapshot,
  type ProjectListComparisonInput,
} from '../../src/core/ProjectListComparison.js';

const observedAt = '2030-06-01T12:00:00.000Z';
const snapshot = (
  items: AuthorizedProjectListSnapshot['items'],
  coverage: AuthorizedProjectListSnapshot['coverage'] = 'complete',
  relationsComplete = coverage === 'complete',
): AuthorizedProjectListSnapshot => ({ items, coverage, relationsComplete });
const compare = (input: Partial<ProjectListComparisonInput>) =>
  compareProjectLists({ observedAt, view: 'all', maxRows: 150, maxBytes: 128 * 1024, ...input });
const plain = (id: string, title = id) => ({ id, title });
const claim = (id: string, targetId: string, state: 'verified' | 'unresolved' = 'verified', title = id) =>
  ({ id, title, relation: { state, targetId } });

describe('private project list comparison projection', () => {
  it('matches by attested ID, never by an identical title, and only outputs approved fields', () => {
    const result = compare({
      projects: snapshot([plain('internal-alpha', 'Similar'), plain('internal-beta', 'Same title')]),
      chiefOfStaff: snapshot([
        claim('internal-tap', 'internal-alpha', 'verified', 'Different title'),
        { ...plain('internal-orphan', 'Same title'), relation: { state: 'none' } },
      ]),
    });
    expect(result).toMatchObject({
      schemaVersion: 1, status: 'complete', observedAt, truncated: false,
      coverage: { projects: { status: 'complete', scope: 'project-kind' }, chiefOfStaff: { status: 'complete', scope: 'confirmed-open-bindings' } },
      rows: expect.arrayContaining([
        expect.objectContaining({ state: 'matched', projects: [{ ordinal: expect.any(Number), title: 'Similar', titleTruncated: false }],
          chiefOfStaff: [{ ordinal: expect.any(Number), title: 'Different title', titleTruncated: false }] }),
        expect.objectContaining({ state: 'projects-only', projects: [expect.objectContaining({ title: 'Same title' })], chiefOfStaff: [] }),
        expect.objectContaining({ state: 'chief-of-staff-only', projects: [], chiefOfStaff: [expect.objectContaining({ title: 'Same title' })] }),
      ]),
    });
    expect(JSON.stringify(result)).not.toMatch(/internal-|targetId|relationsComplete/);
  });

  it('keeps partial eligibility independent of an empty matches selection', () => {
    const inputs = { projects: snapshot([plain('p', 'Current project')], 'partial'), chiefOfStaff: snapshot([], 'partial') };
    expect(compare(inputs)).toMatchObject({ status: 'partial', rows: [expect.objectContaining({ state: 'counterpart-unchecked' })] });
    expect(compare({ ...inputs, view: 'matches' })).toMatchObject({ status: 'partial', rows: [], truncated: false });
    expect(compare({ chiefOfStaff: snapshot([], 'partial') })).toMatchObject({
      status: 'unavailable', rows: [], coverage: { chiefOfStaff: { status: 'unavailable' } },
    });
    expect(compare({ chiefOfStaff: snapshot([]) })).toMatchObject({ status: 'partial', rows: [] });
  });

  it('keeps both endpoints unchecked for a legacy candidate whether or not a verified claimant also exists', () => {
    for (const mixed of [[], [claim('checked-link', 'p')]]) {
      const result = compare({
        projects: snapshot([plain('p')]),
        chiefOfStaff: snapshot([...mixed, claim('legacy', 'p', 'unresolved')]),
      });
      expect(result.coverage.projects.status).toBe('complete');
      expect(result.coverage.chiefOfStaff.status).toBe('complete');
      expect(result.rows).toHaveLength(mixed.length + 2);
      expect(new Set(result.rows.map(row => row.state))).toEqual(new Set(['counterpart-unchecked']));
    }
  });

  it('does not use incomplete claim coverage for an exclusive match or an absence claim', () => {
    const projects = snapshot([plain('p'), plain('other')]);
    const staff = [claim('bound', 'p'), { ...plain('only-staff'), relation: { state: 'none' as const } }];
    const limited = compare({ projects, chiefOfStaff: snapshot(staff, 'partial') });
    expect(limited.rows.map(row => row.state)).toEqual(Array.from({ length: 4 }, () => 'counterpart-unchecked'));

    const independentlyVerified = compare({ projects, chiefOfStaff: snapshot(staff, 'partial', true) });
    expect(independentlyVerified.rows.map(row => row.state)).toEqual(['counterpart-unchecked', 'counterpart-unchecked', 'matched']);
    expect(independentlyVerified.status).toBe('partial');
  });

  it('reports a conflict for two distinct verified visible claims without including an unresolved claimant', () => {
    const result = compare({
      projects: snapshot([plain('p')]),
      chiefOfStaff: snapshot([
        claim('second-internal', 'p', 'verified', 'Duplicate title'),
        claim('first-internal', 'p', 'verified', 'Duplicate title'),
        claim('pending-internal', 'p', 'unresolved', 'Pending'),
      ], 'partial'),
    });
    const group = result.rows.find(row => row.state === 'conflict')!;
    expect(group.projects).toHaveLength(1);
    expect(group.chiefOfStaff.map(row => row.title)).toEqual(['Duplicate title', 'Duplicate title']);
    expect(new Set(group.chiefOfStaff.map(row => row.ordinal)).size).toBe(2);
    expect(result.rows.find(row => row.chiefOfStaff.some(entry => entry.title === 'Pending'))?.state).toBe('counterpart-unchecked');
    expect(JSON.stringify(result)).not.toContain('-internal');
  });

  it('skips oversized atomic groups before returning the later groups that fit', () => {
    const projects = snapshot([plain('p', 'A conflict'), plain('small', 'Z small difference')]);
    const staff = snapshot(Array.from({ length: 8 }, (_unused, index) => claim(`dup-${index}`, 'p', 'verified', '界'.repeat(160))));
    const first = compare({ projects, chiefOfStaff: staff, maxBytes: 430 });
    expect(first).toMatchObject({
      status: 'partial', truncated: true,
      coverage: { projects: { status: 'complete' }, chiefOfStaff: { status: 'complete' } },
      rows: [{ ordinal: 1, state: 'projects-only', projects: [{ ordinal: 1, title: 'Z small difference', titleTruncated: false }], chiefOfStaff: [] }],
    });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(430);
    const noneFits = compare({ projects: snapshot([projects.items[0]]), chiefOfStaff: staff, maxBytes: 430 });
    expect(noneFits).toMatchObject({ status: 'partial', truncated: true, rows: [] });
  });

  it('reports output limits without downgrading complete source coverage', () => {
    const data = { projects: snapshot(Array.from({ length: 151 }, (_unused, index) => plain(`id-${index}`))), chiefOfStaff: snapshot([]) };
    const result = compare(data);
    expect(result.rows).toHaveLength(150);
    expect(result).toMatchObject({ status: 'partial', truncated: true, coverage: { projects: { status: 'complete' }, chiefOfStaff: { status: 'complete' } } });
    const noRows = compare({ ...data, maxRows: 0 });
    expect(noRows).toMatchObject({ truncated: true, rows: [] });
    expect(compare({ ...data, maxBytes: Buffer.byteLength(JSON.stringify(noRows)) })).toEqual(noRows);
    expect(() => compare({ ...data, maxBytes: 1 })).toThrow(RangeError);
  });

  it('marks a shortened title without splitting Unicode code points', () => {
    const title = '🙂'.repeat(160);
    const result = compare({
      projects: snapshot([plain('first', title + ' extra'), plain('second', title)]),
      chiefOfStaff: snapshot([]),
    });
    expect(result.rows.map(row => row.projects[0])).toEqual([
      { ordinal: 1, title, titleTruncated: true },
      { ordinal: 2, title, titleTruncated: false },
    ]);
  });

  it('produces stable title-tie order under source order changes and withholds duplicate native identities', () => {
    const items = [plain('b', 'tIE'), plain('a', 'Tie')];
    expect(compare({ projects: snapshot(items) }).rows).toEqual(compare({ projects: snapshot([...items].reverse()) }).rows);
    const duplicate = compare({ projects: snapshot([plain('same-id', 'first'), plain('same-id', 'second')]), chiefOfStaff: snapshot([]) });
    expect(duplicate).toMatchObject({ status: 'partial', rows: [], coverage: { projects: { status: 'unavailable' } } });
  });
});
