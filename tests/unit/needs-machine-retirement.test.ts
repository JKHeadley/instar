/**
 * SEC-170 part 3: the one agent-wide Needs-you row for computers silent for 7 days or more
 * (source machine-retirement, read GET /pin-budget/silent-machines).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';

const CONSOLE = path.join(process.cwd(), 'dashboard', 'console');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const view = (over: Record<string, unknown> = {}) => ({ enabled: true, rows: [{ machineId: 'm_' + 'b'.repeat(32), name: 'Old Laptop', silentSince: '2026-11-01T00:00:00.000Z', confirmedGone: false }], heldBack: false, evidenceComplete: true, fingerprint: '0123456789abcdef', dismissed: false, show: true, ...over });

describe('machine-retirement Needs-you source', () => {
  it('one pooled row, names only, opening the machines page review', async () => {
    const { silentComputersNeedRows } = await import(path.join(CONSOLE, 'needs-model.js'));
    const rows = silentComputersNeedRows(ok(view({ heldBack: true, rows: [...view().rows, { machineId: 'm_' + 'c'.repeat(32), name: 'Mini', silentSince: '2026-11-02T00:00:00.000Z', confirmedGone: false }] })));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'need:machine-retirement', main: 'Review computers that have been silent', action: { kind: 'href', href: '#/capacity/machines?review=silent' } });
    expect(rows[0].sub).toBe('2 computers have not been heard from in 7 days or more: Old Laptop, Mini. They are holding the PIN guess limit lower. A change to how the limit is split is waiting on them.');
    expect(JSON.stringify(rows)).not.toMatch(/m_b{8}|m_c{8}/);
  });

  it('always explains the reserved limit, distinguishes a waiting change, and never displays ids as names', async () => {
    const { silentComputersNeedRows } = await import(path.join(CONSOLE, 'needs-model.js'));
    const res = silentComputersNeedRows(ok(view({ rows: [{ ...view().rows[0], name: view().rows[0].machineId }] })));
    expect(res[0].sub).toContain('holding the PIN guess limit lower');
    expect(res[0].sub).not.toContain('A change to how the limit is split');
    expect(res[0].sub).not.toContain(view().rows[0].machineId);
    expect(silentComputersNeedRows(ok({ enabled: false }))).toEqual([]);
    expect(silentComputersNeedRows(ok({ rows: [] }))).toBeNull();
  });

  it('says so when some computers could not be checked', async () => {
    const { silentComputersNeedRows } = await import(path.join(CONSOLE, 'needs-model.js'));
    expect(silentComputersNeedRows(ok(view({ evidenceComplete: false })))[0].sub).toMatch(/Some computers could not be checked\./);
  });

  it('switched off, dismissed or empty shows nothing; an unreadable answer is could-not-check', async () => {
    const { silentComputersNeedRows, NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    expect(silentComputersNeedRows(ok(view({ enabled: false })))).toEqual([]);
    expect(silentComputersNeedRows(ok(view({ show: false, dismissed: true })))).toEqual([]);
    expect(silentComputersNeedRows(ok(view({ rows: [], show: false })))).toEqual([]);
    expect(silentComputersNeedRows({ ok: false, status: 503, reason: 'switched off on this agent' })).toEqual([]);
    const unreadable = silentComputersNeedRows({ ok: false, status: 500, reason: 'the server answered 500' });
    expect(Array.isArray(unreadable)).toBe(false);
    expect(silentComputersNeedRows(ok({ nope: true }))).toBe(unreadable);
    expect(NEED_SOURCES.find((s: { id: string }) => s.id === 'machine-retirement')).toMatchObject({ page: 'capacity/machines', reads: { silent: '/pin-budget/silent-machines' } });
  });

  it.each([true, false])('keeps partial evidence incomplete without dropping known rows (show=%s)', async show => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const result = surfacedNeeds({ 'machine-retirement': { results: { silent: ok(view({ show, evidenceComplete: false })) } } });
    expect(result.failed).toContain('machine-retirement');
    expect(result.rows.filter((r: { key: string }) => r.key === 'need:machine-retirement')).toHaveLength(show ? 1 : 0);
  });
  it('the server names it and declares its posture', async () => {
    const { NEED_SOURCE_LABELS, NEED_SOURCE_POSTURE } = await import('../../src/server/needsRoutes.js');
    expect(NEED_SOURCE_LABELS['machine-retirement']).toBe('computers that have been silent');
    expect(NEED_SOURCE_POSTURE['machine-retirement'].posture).toBe('pool-merged');
  });
});
