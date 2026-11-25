import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { mountFleetUsageRoutes } from '../../src/server/fleetUsageRoutes.js';

const NOW = Date.parse('2026-11-25T12:45:00Z');
const sources = [
  { id: 'STUDIO', agentId: 'studio-agent', label: 'Studio', origin: 'https://studio.example.test' },
  { id: 'LAB', agentId: 'lab-agent', label: 'Lab', origin: 'https://lab.example.test' },
  { id: 'DESK', agentId: 'desk-agent', label: 'Desk', origin: 'https://desk.example.test' },
];

function setup(overrides: NodeJS.ProcessEnv = {}, verifyOperator = (proof: string | undefined) => proof === 'owner-fixture') {
  const env = {
    INSTAR_FLEET_USAGE_ENABLED: 'true',
    INSTAR_FLEET_USAGE_SOURCES: JSON.stringify(sources),
    INSTAR_FLEET_USAGE_TOKEN_STUDIO: 'fixture-one',
    INSTAR_FLEET_USAGE_TOKEN_LAB: 'fixture-two',
    INSTAR_FLEET_USAGE_TOKEN_DESK: 'fixture-three',
    ...overrides,
  };
  const fetchSummary = vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'desk.example.test') return new Response(null, { status: 503 });
    const studio = url.hostname === 'studio.example.test';
    return Response.json({
      since: new Date(Number(url.searchParams.get('since'))).toISOString(),
      grain: 'day', scope: studio ? 'pool' : 'this-machine-only', clamped: false,
      total: { partialCalls: 0, tokens: { total: studio ? 80 : 10 } },
      warming: [], notReached: [], secretField: 'never projected',
    });
  });
  const app = express();
  mountFleetUsageRoutes(app, { env, fetchSummary, verifyOperator, now: () => NOW });
  const read = (session = 'owner-fixture') => request(app).get('/usage/fleet').set('X-Instar-Operator-Session', session);
  return { app, fetchSummary, read };
}

describe('fleet usage route', () => {
  it('is off with no flag and never reads other agents on status or a refused request', async () => {
    const { app, read, fetchSummary } = setup({ INSTAR_FLEET_USAGE_ENABLED: undefined });
    await request(app).get('/usage/fleet/status').expect(200, { enabled: false });
    await read().expect(503);
    const on = setup();
    await request(on.app).get('/usage/fleet/status').expect(200, { enabled: true });
    await on.read('').expect(403);
    expect(fetchSummary).not.toHaveBeenCalled();
    expect(on.fetchSummary).not.toHaveBeenCalled();
  });

  it('sums one fixed-window pool read per agent and shows partial coverage without leaking connection details', async () => {
    const { read, fetchSummary } = setup();
    const { body } = await read().expect(200);
    expect(body).toEqual({
      since: '2026-11-19T00:00:00.000Z', tokens: 90, complete: false,
      agents: [
        { label: 'Studio', tokens: 80, coverage: 'complete' },
        { label: 'Lab', tokens: 10, coverage: 'partial' },
        { label: 'Desk', tokens: null, coverage: 'unavailable' },
      ],
    });
    expect(fetchSummary).toHaveBeenCalledTimes(3);
    expect(fetchSummary.mock.calls[0][0].toString()).toMatch(/^https:\/\/studio\.example\.test\/usage\/summary\?since=\d+&grain=day$/);
    expect(fetchSummary.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fixture-one', 'X-Instar-AgentId': 'studio-agent' }, redirect: 'error' });
  });

  it('rejects duplicate origins before requesting a summary', async () => {
    const { read, fetchSummary } = setup({
      INSTAR_FLEET_USAGE_SOURCES: JSON.stringify([sources[0], { ...sources[1], origin: sources[0].origin }]),
    });
    await read().expect(503);
    expect(fetchSummary).not.toHaveBeenCalled();
  });

  it('rejects aliases of the same agent even at different origins', async () => {
    const { read, fetchSummary } = setup({
      INSTAR_FLEET_USAGE_SOURCES: JSON.stringify([sources[0], { ...sources[1], agentId: sources[0].agentId }]),
    });
    await read().expect(503);
    expect(fetchSummary).not.toHaveBeenCalled();
  });

  it('distinguishes unreadable totals from measured zero', async () => {
    const { read, fetchSummary } = setup();
    fetchSummary.mockResolvedValueOnce(Response.json({ total: 0 }));
    fetchSummary.mockImplementationOnce(async input => Response.json({
      since: new Date(Number(new URL(String(input)).searchParams.get('since'))).toISOString(),
      grain: 'day', scope: 'pool', clamped: false, total: { partialCalls: 0, tokens: { total: 0 } }, warming: [], notReached: [],
    }));
    const { body } = await read().expect(200);
    expect(body.tokens).toBe(0);
    expect(body.agents[0].tokens).toBeNull();
    expect(body.agents[1].tokens).toBe(0);
  });

  it('withholds a read if the unlock expires during collection', async () => {
    let valid = true;
    const { read, fetchSummary } = setup({}, () => valid);
    fetchSummary.mockImplementationOnce(async () => {
      valid = false;
      return new Response(null, { status: 503 });
    });
    await read().expect(403);
  });
});
