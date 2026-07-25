import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { CapabilityRegistryReceiver } from '../../src/core/CapabilityRegistry.js';

function app(enabled: boolean) {
  const server = express();
  server.use(createRoutes({ config: { authToken: 'test', port: 0, stateDir: '/tmp' , capabilityRegistry: enabled ? { enabled: true } : { enabled: false } } as any, capabilityRegistry: new CapabilityRegistryReceiver() } as any));
  return server;
}

describe('Capability registry production route contract', () => {
  it('disabled is a named 503, never an empty 200', async () => {
    const response = await request(app(false)).get('/capability-registry');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('capability-registry-disabled');
  });

  it('enabled and unobserved is a truthful 200 with scanState', async () => {
    const response = await request(app(true)).get('/capability-registry');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scanState: 'never-observed', capabilities: [] });
  });
});
