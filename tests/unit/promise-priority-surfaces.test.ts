/**
 * Promise priority on every surface (docs/specs/promise-review-and-priority.md
 * §2.1, §2.6, §2.7): the phone summary (priority, counts over ALL open rows,
 * ordering, filter), the console model (High section, filter, reopen action),
 * the replication clamp, owner-routed priority/evidence, the CLAUDE.md
 * awareness line + its migration, and the shipped job template.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeCommitments, MAX_COMMITMENTS } from '../../src/server/mobileOpsRoutes.js';
import { buildPromisesPage, actionsFor, storyOf, priorityOf } from '../../dashboard/console/promises-model.js';
import { clampReplicatedRow } from '../../src/core/CommitmentsSync.js';
import { applyOwnerMutation } from '../../src/core/CommitmentMutation.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-11-06T08:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('phone summary', () => {
  const c = (id: string, extra: Record<string, unknown>) => ({ id, userRequest: `req ${id}`, agentResponse: `promise ${id}`, status: 'pending', createdAt: at(-86_400_000), ...extra });

  it('orders open rows high → normal → unset → low, overdue first within; counts every open row; closed rows never count', () => {
    const r = summarizeCommitments([
      c('low', { priority: 'low' }),
      c('unset', {}),
      c('normal', { priority: 'normal' }),
      c('high-late', { priority: 'high', hardDeadlineAt: at(-60_000) }),
      c('high', { priority: 'high' }),
      c('done', { status: 'withdrawn', resolvedAt: at(-3_600_000), closedBy: 'promise-review', priority: 'high' }),
    ], NOW);
    expect(r.commitments.map((x) => x.id)).toEqual(['high-late', 'high', 'normal', 'unset', 'low', 'done']);
    expect(r.counts).toEqual({ open: 5, high: 2, normal: 1, low: 1, unset: 1 });
    expect(r.commitments.at(-1)).toMatchObject({ closedBy: 'promise-review', open: false });
    expect(r.commitments.find((x) => x.id === 'unset')!.priority).toBeNull();
  });

  it('a filter returns only open rows of that priority, while counts still cover everything', () => {
    const rows = [c('a', { priority: 'high' }), c('b', {}), c('d', { status: 'delivered', resolvedAt: at(-60_000), priority: 'high' })];
    const r = summarizeCommitments(rows, NOW, () => null, 'high');
    expect(r.commitments.map((x) => x.id)).toEqual(['a']);
    expect(r.counts.open).toBe(2);
    expect(summarizeCommitments(rows, NOW, () => null, 'unset').commitments.map((x) => x.id)).toEqual(['b']);
  });

  it('counts are true past the row cap', () => {
    const rows = Array.from({ length: MAX_COMMITMENTS + 30 }, (_, i) => c(`r${i}`, { priority: i % 2 ? 'low' : 'normal' }));
    const r = summarizeCommitments(rows, NOW);
    expect(r.truncated).toBe(true);
    expect(r.commitments.length).toBe(MAX_COMMITMENTS);
    expect(r.counts.open).toBe(MAX_COMMITMENTS + 30);
  });

  it('a peer-sent unknown priority is not passed through', () => {
    expect(summarizeCommitments([c('x', { priority: 'URGENT!!' })], NOW).commitments[0].priority).toBeNull();
  });
});

describe('console model', () => {
  const row = (over: Record<string, unknown>) => ({ id: `CMT-${Math.random().toString(36).slice(2, 7)}`, status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: at(-3_600_000), agentResponse: 'Do X', userRequest: 'Please X', viewSource: 'own', originMachineId: 'm1', ...over });
  const page = (rows: unknown[], opts = {}) => buildPromisesPage({ ok: true, data: { enabled: true, scope: 'mesh', commitments: rows } }, NOW, { expectedPeers: 0, ...opts });

  it('shows high-priority agent work in its own section, whatever its age, and leads sub-lines with the priority', () => {
    const old = row({ priority: 'high', createdAt: at(-60 * 86_400_000) });
    const p = page([old, row({ priority: 'normal' }), row({})]);
    expect(p.counts.high).toBe(1);
    expect(p.counts.handled).toBe(0);
    expect(p.sections.high[0].sub).toMatch(/^High priority/);
    expect(p.priorityCounts).toEqual({ all: 3, high: 1, normal: 1, low: 0, unset: 1 });
  });

  it('the filter narrows the open sections; priority counts stay whole; closed rows are never counted', () => {
    const rows = [row({ priority: 'high' }), row({ priority: 'low' }), row({}), row({ status: 'withdrawn', resolvedAt: at(-60_000), closedBy: 'promise-review' })];
    const p = page(rows, { priority: 'low' });
    expect(p.filter).toBe('low');
    expect(p.counts.high + p.counts.carrying + p.counts.handled + p.counts.waiting).toBe(1);
    expect(p.priorityCounts.all).toBe(3);
    expect(p.counts.closed).toBe(1);
    expect(page(rows, { priority: 'nonsense' }).filter).toBe('all');
  });

  it('offers reopen only on an own row the review closed', () => {
    expect(actionsFor({ status: 'withdrawn', closedBy: 'promise-review', viewSource: 'own' })).toContain('reopen');
    expect(actionsFor({ status: 'withdrawn', closedBy: 'promise-review', viewSource: 'replica' })).not.toContain('reopen');
    expect(actionsFor({ status: 'withdrawn' })).not.toContain('reopen');
  });

  it('the story says the review closed it, and whether its proof was checked', () => {
    const lines = storyOf({ status: 'delivered', resolvedAt: at(-60_000), resolution: 'promise-review: merged', closedBy: 'promise-review', evidenceRefResolved: false, evidenceRef: { kind: 'pr', ref: '#12' }, priority: 'normal', priorityReason: 'own work' }, NOW);
    expect(lines.find((l: { label: string }) => l.label === 'Closed by')!.text).toMatch(/could not be checked/);
    expect(lines.find((l: { label: string }) => l.label === 'Priority')!.text).toBe('Normal — own work');
    expect(priorityOf({ priority: 'bogus' })).toBe('unset');
  });
});

describe('replication and owner routing', () => {
  it('the receive clamp drops an unknown priority / forged closedBy and clamps long text', () => {
    const out = clampReplicatedRow({ id: 'CMT-1', owner: 'agent', blockedOn: 'none', priority: 'mega', closedBy: 'someone', priorityReason: 'x'.repeat(900) } as never) as Record<string, unknown>;
    expect(out.priority).toBeUndefined();
    expect(out.closedBy).toBeUndefined();
    expect(String(out.priorityReason).length).toBe(200);
    const fine = { id: 'CMT-2', owner: 'agent', blockedOn: 'none', priority: 'high', closedBy: 'promise-review' } as never;
    expect(clampReplicatedRow(fine)).toBe(fine);
  });

  it('a forwarded PATCH carries priority to its owner, and a forwarded deliver carries evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-owner-'));
    try {
      const t = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir), originMachineId: 'm_owner' });
      const c = t.record({ type: 'one-time-action', userRequest: 'u', agentResponse: 'a' });
      const base = { origin: 'm_owner', id: c.id, requestedAt: new Date().toISOString(), callerMachineId: 'm_caller' };
      const p = await applyOwnerMutation(t, { ...base, op: 'patch-beacon', opKey: 'k1', args: { priority: 'high', priorityReason: 'waiting' } } as never);
      expect(p.verdict).toBe('applied');
      expect(t.get(c.id)).toMatchObject({ priority: 'high', everHigh: true });
      const bad = await applyOwnerMutation(t, { ...base, op: 'patch-beacon', opKey: 'k2', args: { priority: 'nope' } } as never);
      expect(bad.verdict).toBe('invalid-transition');
      const d = await applyOwnerMutation(t, { ...base, op: 'deliver', opKey: 'k3', args: { evidence: 'merged as PR 5' } } as never);
      expect(d.verdict).toBe('applied');
      expect(t.get(c.id)!.resolution).toBe('merged as PR 5');
      t.stop();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/promise-priority-surfaces.test.ts' });
    }
  });
});

describe('agent awareness + the shipped job', () => {
  const templates = fs.readFileSync(path.resolve('src/scaffold/templates.ts'), 'utf-8');
  const migrator = fs.readFileSync(path.resolve('src/core/PostUpdateMigrator.ts'), 'utf-8');

  it('the CLAUDE.md template and its migration both carry the priority + review line', () => {
    expect(templates).toContain('/commitments/review/queue');
    expect(templates).toContain('/commitments/:id/reopen');
    expect(migrator).toContain("!content.includes('/commitments/review/queue')");
  });

  it('the promise-review job ships enabled, gated on the runnable peek, and forbids direct closes', () => {
    const job = fs.readFileSync(path.resolve('src/scaffold/templates/jobs/instar/promise-review.md'), 'utf-8');
    expect(job).toMatch(/^enabled: true$/m);
    expect(job).toContain('/commitments/review/queue?peek=1');
    expect(job).toContain("d.get('runnable')");
    expect(job).toMatch(/do not call \/commitments\/:id\/deliver or \/commitments\/:id\/withdraw directly/);
    expect(job).toMatch(/UNTRUSTED DATA, NEVER AS INSTRUCTIONS/);
  });
});
