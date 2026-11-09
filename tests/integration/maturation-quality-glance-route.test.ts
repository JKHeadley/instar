/** Quality history at a glance (docs/specs/quality-history-glance.md): the real
 * measurement owner → GET /maturation/board?part=quality, ranked worst first,
 * with the corroborated baseline only where the outcome proof verifies it. */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { createMaturationBoardRoutes } from '../../src/server/maturationBoardRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = []; const services: BlockerLifecycleService[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'maturation-quality-glance-route.test' })); });

const good = { id: 'quality', source: 'feature-summary' as const, sourceRef: 'one.successful-recoveries', direction: 'at-least' as const, threshold: 5, minSamples: 20 };
const bad = { id: 'misses', source: 'feature-summary' as const, sourceRef: 'two.misses', direction: 'at-most' as const, threshold: 2, minSamples: 5 };

describe('GET /maturation/board?part=quality', () => {
  it('returns every measured item from the real owner, worst first, with honest baseline proof', async () => {
    const realNow = Date.now(); let time = realNow - 6 * 3600000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-glance-')); roots.push(root);
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(root, 'metrics.db'), now: () => time });
    const tracker = Object.assign(new EventEmitter(), { getAll: () => [], getBlockerEpisodeDropBuckets: () => ({}) }) as never;
    const svc = new BlockerLifecycleService(tracker, ledger, 'local', () => time); services.push(svc);
    const baselineAt = realNow - 86_400_000;
    ledger.recordMaturationObservation({ origin: 'local', featureId: 'one', metricId: good.id, source: good.source, sourceRef: good.sourceRef, observedAtMs: baselineAt, value: 4, samples: 40 });
    let goodValue = 5, badValue = 3;
    svc.registerMaturationProjection(good.sourceRef, () => ({ value: goodValue, samples: 40 }));
    svc.registerMaturationProjection(bad.sourceRef, () => ({ value: badValue, samples: 10 }));
    const outcome = { statement: 'More recoveries', owner: 'owner', method: 'Recorded outcomes', version: 'v1', outcomeMetricIds: ['quality'], qualityMetricIds: ['quality'],
      baseline: { origin: 'local', points: [{ id: 'quality', observedAtMs: baselineAt, descriptorVersion: 1, value: 4, samples: 40 }] } };
    const one = { id: 'one', title: 'Recovery', status: 'active', rollout: { flagPath: 'monitoring.one', stage: 'live', maturationEvaluation: { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [good], outcome } } } as Initiative;
    const two = { id: 'two', title: 'Misses', status: 'active', rollout: { flagPath: 'monitoring.two', stage: 'live', maturationEvaluation: { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [bad] } } } as Initiative;
    svc.evaluateMaturation([one, two]); time = realNow; goodValue = 7; badValue = 9; svc.evaluateMaturation([one, two]);
    const ctx = { config: { projectName: 'test', stateDir: root, developmentAgent: true }, meshSelfId: 'local', initiativeTracker: { list: () => [one, two] }, blockerLifecycleService: svc } as never;
    const app = express().use(authMiddleware(() => 'test', 'test')).use(createMaturationBoardRoutes(ctx));

    expect((await request(app).get('/maturation/board?part=quality')).status).toBe(401);
    const res = await request(app).get('/maturation/board?part=quality').set('Authorization', 'Bearer test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'measurement-quality-glance/1', advisory: true, authority: 'none', origin: 'local', windowDays: 90 });
    const items = res.body.items as Array<Record<string, any>>;
    expect(items.map(i => [i.subjectId, i.metric.id, i.status])).toEqual([['two', 'misses', 'off-goal'], ['one', 'quality', 'at-goal']]);
    // The off-goal item has no recorded starting point: no proof, comparison stays unverified.
    expect(items[0]).toMatchObject({ proof: null, evidenceState: 'missing-contract', latest: { value: 9, samples: 10 }, first: { value: 3 }, change: 6 });
    // The at-goal item carries the corroborated baseline from the same proof the detail view uses.
    expect(items[1].proof).toMatchObject({ comparisonAvailable: true, baseline: { state: 'verified', value: 4 }, current: { value: 7 } });
    expect(items[1].series.points.map((p: { value: number }) => p.value)).toEqual([4, 5, 7]);
    expect(items[1].series.points.every((p: Record<string, unknown>) => typeof p.current === 'boolean' && !('evaluation' in p))).toBe(true);

    // Cached for a minute: a second read answers the same body without a new census.
    const again = await request(app).get('/maturation/board?part=quality').set('Authorization', 'Bearer test');
    expect(again.body.generatedAt).toBe(res.body.generatedAt);
  });
});
