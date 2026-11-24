import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProjectListComparisonRouter, type ProjectComparisonSources } from '../../src/server/projectListComparisonRoutes.js';

const PATH = '/work/projects/compare';

function fixture(sources: ProjectComparisonSources, current = () => true) {
  return express().use(createProjectListComparisonRouter({
    enabled: () => true,
    mayReadPrivateWork: (req) => req.get('Authorization') === 'Bearer dst_fixture' && current(),
    sources, providerCutoffMs: 65, responseDeadlineMs: 300,
  }));
}

function verified(title: string, release = () => true) {
  return {
    snapshot: { coverage: 'complete' as const, items: [{ id: 'private-id', title }], relationsComplete: false },
    release,
  };
}

function holdingReader() {
  let finish!: () => void;
  let abortSignal: AbortSignal | undefined;
  const read = vi.fn((signal: AbortSignal) => {
    abortSignal = signal;
    return new Promise<null>(resolve => { finish = () => resolve(null); });
  });
  return { read, finish: () => finish(), aborted: () => abortSignal?.aborted };
}

describe('private project list comparison', () => {
  it('rejects raw bearers and invalid query or body before either provider', async () => {
    const read = vi.fn(async () => verified('Private title'));
    const app = fixture({ projects: { read }, chiefOfStaff: { read } });
    await request(app).get(PATH).set('Authorization', 'Bearer raw').expect(403).expect('Cache-Control', 'no-store');
    await request(app).head(PATH).set('Authorization', 'Bearer raw').expect(403);
    await request(app).head(PATH).set('Authorization', 'Bearer dst_fixture').expect(204);
    await request(app).head(PATH + '?view=all').set('Authorization', 'Bearer dst_fixture').expect(400);
    await request(app).get(PATH + '?view=all&view=matches').set('Authorization', 'Bearer dst_fixture').expect(400);
    await request(app).get(PATH).set('Authorization', 'Bearer dst_fixture').send({ view: 'all' }).expect(400);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['projects', 'chiefOfStaff'] as const)('preserves a healthy %s source when its peer stalls', async (side) => {
    const other = side === 'projects' ? 'chiefOfStaff' : 'projects';
    const held = holdingReader();
    const app = fixture({
      [side]: { read: async () => verified('Visible healthy title') },
      [other]: held,
    });
    const first = await request(app).get(PATH).set('Authorization', 'Bearer dst_fixture').expect(200);
    expect(first.body).toMatchObject({
      status: 'partial',
      coverage: { [side]: { status: 'complete' }, [other]: { status: 'unavailable' } },
      rows: [{ state: 'counterpart-unchecked', [side]: [{ title: 'Visible healthy title' }] }],
    });
    expect(first.text).not.toContain('private-id');
    expect(held.aborted()).toBe(true);
    await request(app).get(PATH).set('Authorization', 'Bearer dst_fixture').expect(429);
    held.finish();
    await vi.waitFor(() => expect(held.read).toHaveBeenCalledTimes(1));
  });

  it('omits stale source evidence and denies release when the owner session changed', async () => {
    let sessionCurrent = true;
    const app = fixture({ projects: {
      read: async () => {
        sessionCurrent = false;
        return verified('Revoked owner data');
      },
    } }, () => sessionCurrent);
    const denied = await request(app).get(PATH).set('Authorization', 'Bearer dst_fixture').expect(403);
    expect(denied.text).not.toContain('Revoked owner data');

    const stale = fixture({ projects: { read: async () => verified('Stale projection', () => false) } });
    const response = await request(stale).get(PATH).set('Authorization', 'Bearer dst_fixture').expect(503);
    expect(response.body).toMatchObject({ status: 'unavailable', rows: [] });
    expect(response.text).not.toContain('Stale projection');
  });
});
