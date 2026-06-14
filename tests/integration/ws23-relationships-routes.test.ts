/**
 * Tier-2 integration test for WS2.3 — the relationship HTTP routes with the
 * replication emit seam attached. Proves the full HTTP pipeline still works when the
 * WS2.3 replication funnel is wired (regression), AND that a route-driven mutation
 * (DELETE /relationships/:id) fires the channel-keyed tombstone emit through the same
 * funnel — the emit-on-mutation contract holds end-to-end over HTTP, not just in unit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import request from 'supertest';

import { AgentServer } from '../../src/server/AgentServer.js';
import { RelationshipManager, type RelationshipReplicationEmitter } from '../../src/core/RelationshipManager.js';
import { deriveRelationshipRecordKey } from '../../src/core/RelationshipsReplicatedStore.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig, UserChannel } from '../../src/core/types.js';

describe('WS2.3 relationship routes + replication funnel (integration)', () => {
  let project: TempProject;
  let relationships: RelationshipManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const puts: string[] = [];
  const deletes: { channels: UserChannel[]; deletedAt: string }[] = [];
  let aliceId: string;

  const fakeConfig: InstarConfig = {
    projectName: 'test-project', projectDir: '/tmp/test', stateDir: '/tmp/test/.instar', port: 0,
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: '/tmp/test', maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2 },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as unknown as InstarConfig;

  beforeAll(async () => {
    project = createTempProject();
    const relDir = path.join(project.stateDir, 'relationships');
    const emitter: RelationshipReplicationEmitter = {
      emitPut: (r) => { puts.push(r.id); },
      emitDelete: (channels, deletedAt) => { deletes.push({ channels: [...channels], deletedAt }); },
    };
    relationships = new RelationshipManager({ relationshipsDir: relDir, maxRecentInteractions: 20 }, emitter);
    const alice = relationships.findOrCreate('Alice', { type: 'telegram', identifier: '111' });
    aliceId = alice.id;

    server = new AgentServer({
      config: { ...fakeConfig, stateDir: project.stateDir, projectDir: project.dir },
      sessionManager: createMockSessionManager() as never,
      state: { /* minimal */ } as never,
      relationships,
    } as never);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server?.stop();
    project?.cleanup();
  });

  it('GET /relationships still lists records with the replication seam attached', async () => {
    const res = await request(app).get('/relationships');
    expect(res.status).toBe(200);
    expect(res.body.relationships.some((r: { name: string }) => r.name === 'Alice')).toBe(true);
  });

  it('the create at setup time fired a put through the funnel', () => {
    expect(puts).toContain(aliceId);
  });

  it('DELETE /relationships/:id fires a channel-keyed tombstone through the funnel', async () => {
    const channelsBefore = [...relationships.get(aliceId)!.channels];
    deletes.length = 0;
    const res = await request(app).delete(`/relationships/${aliceId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deletes).toHaveLength(1);
    // The tombstone keys on the channel-set identity surface (REQ-D4/D17).
    expect(deriveRelationshipRecordKey(deletes[0].channels)).toBe(deriveRelationshipRecordKey(channelsBefore));
  });
});
