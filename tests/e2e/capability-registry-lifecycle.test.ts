import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { CapabilityRegistryReceiver, type CapabilityProjection } from '../../src/core/CapabilityRegistry.js';

function app(enabled: boolean) {
  const server = express();
  server.use(createRoutes({ config: { authToken: 'test', port: 0, stateDir: '/tmp' , capabilityRegistry: enabled ? { enabled: true } : { enabled: false } } as any, capabilityRegistry: new CapabilityRegistryReceiver() } as any));
  return server;
}

describe('Capability registry production route contract', () => {
  it('disabled is a named 503, never an empty 200', async () => {
    const response = await request(app(false)).get('/capability-registry');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('capability-registry-dark');
  });

  it('enabled and unobserved is a truthful 200 with scanState', async () => {
    const response = await request(app(true)).get('/capability-registry');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ advisory: true, scanState: 'never-observed', capabilities: [] });
  });

  it('omitted flag follows the development-agent gate', async () => {
    const server = express();
    server.use(createRoutes({ config: { authToken: 'test', port: 0, stateDir: '/tmp', developmentAgent: true } as any, capabilityRegistry: new CapabilityRegistryReceiver() } as any));
    const response = await request(server).get('/capability-registry');
    expect(response.status).toBe(200);
    expect(response.body.scanState).toBe('never-observed');
  });

  it('enabled route renders an ingested projection instead of a hardcoded empty list', async () => {
    const registry = new CapabilityRegistryReceiver();
    const p = { schemaVersion: 1, machineId: 'm1', machineEpoch: 1, projectionSeq: 1, scanStampSecs: 1, scanState: 'observed', truncated: false, entries: [{ capabilityId: 'models:claude-code/a', capabilityKind: 'model', doorwayId: 'claude-code', machineId: 'm1', probeOutcome: 'positive', endpointRef: 'mesh://m1/doorways', observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), source: 'local-doorways', sourceDetail: 'doorway-scan', evidenceClass: 'probe-answered', evidence: {} }] } as CapabilityProjection;
    registry.ingestProjection('m1', p, Date.now(), true);
    const server = express();
    server.use(createRoutes({ config: { authToken: 'test', port: 0, stateDir: '/tmp', capabilityRegistry: { enabled: true } } as any, capabilityRegistry: registry } as any));
    const response = await request(server).get('/capability-registry');
    expect(response.status).toBe(200);
    expect(response.body.capabilities).toHaveLength(1);
    expect(response.body.advisory).toBe(true);
    expect(response.body.scanState).toBe('observed');
    expect(response.body.capabilities[0].entry.capabilityId).toBe('models:claude-code/a');
  });

  it('health preserves a measurement surface', async () => {
    const response = await request(app(true)).get('/capability-registry/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ advisory: true, scanState: 'never-observed', origins: 0, rows: 0, failures: 0 });
  });
});
