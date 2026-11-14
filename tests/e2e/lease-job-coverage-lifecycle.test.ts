import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { acceptJobCoverage } from '../../src/core/JobCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { leaseJobHttpFixture } from '../helpers/lease-job-http.js';
import { createMockSessionManager } from '../helpers/setup.js';

describe('lease job coverage production lifecycle', () => {
  let fixture: Awaited<ReturnType<typeof leaseJobHttpFixture>>;
  let server: AgentServer;
  afterEach(async () => {
    await server?.stop();
    fixture?.coordinator.stop();
    if (fixture) SafeFsExecutor.safeRmSync(fixture.root, { recursive: true, force: true, operation: 'lease-job-coverage-lifecycle-cleanup' });
  });

  it('constructs the real monitor through AgentServer, with signed coverage alive before scheduler takeover', async () => {
    fixture = await leaseJobHttpFixture();
    server = new AgentServer({ config: fixture.config, state: fixture.state,
      coordinator: fixture.coordinator, meshSelfId: fixture.identity.machineId,
      sessionManager: createMockSessionManager() as never, telegram: null,
      resolvePeerUrls: () => [],
    });
    const response = await request(server.getApp()).get('/jobs/coverage-snapshot?nonce=' + 'c'.repeat(64))
      .set('Authorization', `Bearer ${fixture.config.authToken}`);
    expect(response.status).toBe(200);
    const key = fixture.identityManager.getSigningPublicKeyPem(fixture.identity.machineId)!;
    expect(acceptJobCoverage(response.body, fixture.identity.machineId, 'c'.repeat(64), key))
      .toMatchObject({ complete: true, machineId: fixture.identity.machineId });
    expect((await request(server.getApp()).get('/jobs/coverage-snapshot?nonce=' + 'c'.repeat(64))).status).toBe(401);
  });
});
