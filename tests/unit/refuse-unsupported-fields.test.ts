/**
 * The shared refusal for write routes (refuseUnsupportedFields) and the two
 * routes whose fix was more than one line: PATCH /api/files/config, whose
 * documented `{enabled}` toggle was silently ignored while the route answered
 * `updated: true`, and the InitiativeTracker field list the initiatives route
 * now refuses against.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { refuseUnsupportedFields } from '../../src/server/refuseUnsupportedFields.js';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import { INITIATIVE_UPDATE_FIELDS } from '../../src/core/InitiativeTracker.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function probe(supported: string[]) {
  const app = express();
  app.use(express.json());
  app.patch('/x', (req, res) => {
    if (refuseUnsupportedFields(res, req.body, supported)) return;
    res.json({ applied: req.body ?? null });
  });
  return app;
}

describe('refuseUnsupportedFields', () => {
  it('passes a body made only of supported fields, and an empty body', async () => {
    const app = probe(['a', 'b']);
    await request(app).patch('/x').send({ a: 1 }).expect(200);
    await request(app).patch('/x').send({ a: 1, b: 2 }).expect(200);
    await request(app).patch('/x').send({}).expect(200);
    await request(app).patch('/x').expect(200);
  });

  it('refuses every unknown field by name, listing what is supported', async () => {
    const res = await request(probe(['a', 'b'])).patch('/x').send({ a: 1, c: 2, d: 3 }).expect(400);
    expect(res.body).toEqual({ error: 'Unsupported field(s): c, d', unsupportedFields: ['c', 'd'], supportedFields: ['a', 'b'] });
  });

  it('refuses a body that is not a JSON object', async () => {
    const res = await request(probe(['a'])).patch('/x').send([1, 2]).expect(400);
    expect(res.body.error).toBe('Request body must be a JSON object');
  });
});

describe('INITIATIVE_UPDATE_FIELDS', () => {
  it('lists the fields update() applies and nothing the tracker owns itself', () => {
    expect(INITIATIVE_UPDATE_FIELDS).toEqual(expect.arrayContaining(['title', 'status', 'nextCheckAt', 'rollout', 'ifMatch']));
    for (const owned of ['id', 'createdAt', 'updatedAt', 'version', 'phases']) expect(INITIATIVE_UPDATE_FIELDS).not.toContain(owned);
  });
});

describe('PATCH /api/files/config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'files-config-refuse-'));
  fs.writeFileSync(path.join(tmp, 'a.md'), '# a');
  afterAll(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/refuse-unsupported-fields.test.ts' }));

  function app() {
    const sets: Array<[string, unknown]> = [];
    const config = { projectDir: tmp, stateDir: path.join(tmp, '.instar'), dashboard: { fileViewer: { enabled: true, allowedPaths: ['./'], editablePaths: [] } } } as unknown as InstarConfig;
    const a = express();
    a.use(express.json());
    a.use(createFileRoutes({ config, liveConfig: { set: (p, v) => { sets.push([p, v]); } } }));
    return { a, sets };
  }

  it('refuses an unknown field and changes nothing', async () => {
    const { a, sets } = app();
    const res = await request(a).patch('/api/files/config').set('X-Instar-Request', '1').send({ allowedPaths: ['docs/'], bogus: 1 }).expect(400);
    expect(res.body.unsupportedFields).toEqual(['bogus']);
    expect(sets).toEqual([]);
  });

  it('applies the documented enabled toggle: disabling turns the file routes off now, not after a restart', async () => {
    const { a, sets } = app();
    await request(a).get('/api/files/list').query({ path: '.' }).expect(200);
    const off = await request(a).patch('/api/files/config').set('X-Instar-Request', '1').send({ enabled: false }).expect(200);
    expect(off.body.enabled).toBe(false);
    expect(sets).toEqual([['dashboard.fileViewer.enabled', false]]);
    await request(a).get('/api/files/list').query({ path: '.' }).expect(404);
    await request(a).get('/api/files/download').query({ path: 'a.md' }).expect(404);
    const on = await request(a).patch('/api/files/config').set('X-Instar-Request', '1').send({ enabled: true }).expect(200);
    expect(on.body.enabled).toBe(true);
    await request(a).get('/api/files/list').query({ path: '.' }).expect(200);
  });

  it('refuses a non-boolean enabled', async () => {
    const { a } = app();
    await request(a).patch('/api/files/config').set('X-Instar-Request', '1').send({ enabled: 'no' }).expect(400);
  });
});
