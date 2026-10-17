/**
 * Tier 2 integration tests — GET /evolution/session-brief over the real HTTP
 * pipeline with a real EvolutionManager behind it (PROP-969).
 *
 * The route is what makes the lane reachable from a bash hook, so the contract
 * that matters here is: the counts a hook would print are the FULL counts, the
 * rendered lines come back ready to echo, and an agent with no evolution system
 * gets a quiet 200 instead of a 503 that would make the hook noisy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const tmpDirs: string[] = [];
const HOUR = 3_600_000;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/evolution-session-brief-route.test.ts',
      });
    } catch {
      // Test cleanup only.
    }
  }
});

function makeHarness(opts: { withEvolution?: boolean } = {}): {
  app: express.Express;
  evolution: EvolutionManager | null;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-session-brief-'));
  tmpDirs.push(stateDir);
  const evolution = opts.withEvolution === false ? null : new EvolutionManager({ stateDir });
  const ctx = {
    config: { authToken: '', stateDir, projectDir: stateDir, port: 0 },
    evolution,
    classReviewStore: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, evolution };
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * HOUR).toISOString();
}

describe('GET /evolution/session-brief', () => {
  it('serves an overdue row with its rendered surfacing line', async () => {
    const { app, evolution } = makeHarness();
    evolution!.addAction({
      title: 'Land the dissent ledger',
      description: 'The fourth move needs to cost what concurring costs.',
      priority: 'high',
      dueBy: hoursFromNow(-30),
      source: { context: 'doubts are leaving no record' },
    });

    const res = await request(app).get('/evolution/session-brief');

    expect(res.status).toBe(200);
    expect(res.body.overdueCount).toBe(1);
    expect(res.body.inWindowCount).toBe(0);
    expect(res.body.datedPendingCount).toBe(1);
    expect(res.body.items[0].state).toBe('overdue');
    expect(res.body.items[0].blocking).toBe('doubts are leaving no record');
    expect(res.body.lines[0]).toContain('1 OVERDUE');
    expect(res.body.lines.join('\n')).toContain('OVERDUE 30h');
  });

  it('serves a fast-track-tagged row before its deadline', async () => {
    const { app, evolution } = makeHarness();
    evolution!.addAction({
      title: 'Flip the shadow gate',
      description: 'Soak window closes tonight.',
      priority: 'critical',
      dueBy: hoursFromNow(5),
      tags: ['fast-track'],
    });

    const res = await request(app).get('/evolution/session-brief');

    expect(res.status).toBe(200);
    expect(res.body.overdueCount).toBe(0);
    expect(res.body.inWindowCount).toBe(1);
    expect(res.body.items[0].hoursRemaining).toBe(5);
    expect(res.body.lines[0]).toContain('1 in-window');
  });

  it('returns whole counts even when the printed rows are capped', async () => {
    const { app, evolution } = makeHarness();
    for (let i = 0; i < 7; i += 1) {
      evolution!.addAction({
        title: `slipped commitment ${i}`,
        description: 'seeded',
        priority: 'high',
        dueBy: hoursFromNow(-20 - i),
      });
    }

    const res = await request(app).get('/evolution/session-brief');

    expect(res.body.overdueCount).toBe(7);
    expect(res.body.items).toHaveLength(7);
    expect(res.body.lines.filter((l: string) => l.startsWith('  [OVERDUE'))).toHaveLength(5);
    expect(res.body.lines.join('\n')).toContain('+2 more');
  });

  it('stays quiet — 200 with no lines — when nothing has slipped', async () => {
    const { app, evolution } = makeHarness();
    evolution!.addAction({
      title: 'Comfortably ahead',
      description: 'seeded',
      priority: 'low',
      dueBy: hoursFromNow(200),
    });

    const res = await request(app).get('/evolution/session-brief');

    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.datedPendingCount).toBe(1);
  });

  it('answers 200 with an empty brief when the agent has no evolution system', async () => {
    const { app } = makeHarness({ withEvolution: false });

    const res = await request(app).get('/evolution/session-brief');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      overdueCount: 0,
      inWindowCount: 0,
      datedPendingCount: 0,
      items: [],
      onTimeRate: null,
      lines: [],
    });
  });

  it('does not shadow the sibling overdue route', async () => {
    const { app, evolution } = makeHarness();
    evolution!.addAction({
      title: 'slipped',
      description: 'seeded',
      priority: 'high',
      dueBy: hoursFromNow(-2),
    });

    const overdue = await request(app).get('/evolution/actions/overdue');

    expect(overdue.status).toBe(200);
    expect(overdue.body.overdue).toHaveLength(1);
  });
});
