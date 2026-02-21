/**
 * Integration test — Private view and tunnel routes.
 *
 * Tests the /view, /views, /tunnel, and /capabilities endpoints
 * with a real PrivateViewer (filesystem-backed).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { PrivateViewer } from '../../src/publishing/PrivateViewer.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('View & Tunnel routes integration', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let viewer: PrivateViewer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    viewer = new PrivateViewer({
      viewsDir: path.join(project.stateDir, 'views'),
    });

    const config: InstarConfig = {
      projectName: 'test-views',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      sessions: {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      scheduler: {
        jobsFile: path.join(project.stateDir, 'jobs.json'),
        enabled: false,
        maxParallelJobs: 2,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      users: [],
      messaging: [],
      monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
    };

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      viewer,
    });

    app = server.getApp();
  });

  afterAll(() => {
    project.cleanup();
  });

  describe('POST /view', () => {
    it('creates a private view and returns metadata', async () => {
      const res = await request(app)
        .post('/view')
        .send({
          title: 'Test Report',
          markdown: '# Hello\n\nThis is **bold**.',
        })
        .expect(201);

      expect(res.body.id).toMatch(/^[0-9a-f]{8}-/);
      expect(res.body.title).toBe('Test Report');
      expect(res.body.localUrl).toMatch(/^\/view\/[0-9a-f]{8}-/);
      expect(res.body.tunnelUrl).toBeNull(); // No tunnel in this test
      expect(res.body.createdAt).toBeTruthy();
    });

    it('validates title is required', async () => {
      const res = await request(app)
        .post('/view')
        .send({ markdown: 'content' })
        .expect(400);

      expect(res.body.error).toContain('title');
    });

    it('validates markdown is required', async () => {
      const res = await request(app)
        .post('/view')
        .send({ title: 'Test' })
        .expect(400);

      expect(res.body.error).toContain('markdown');
    });

    it('rejects oversized markdown', async () => {
      const res = await request(app)
        .post('/view')
        .send({ title: 'Big', markdown: 'x'.repeat(501_000) })
        .expect(400);

      expect(res.body.error).toContain('500KB');
    });
  });

  describe('GET /view/:id', () => {
    it('returns rendered HTML', async () => {
      // Create a view first
      const createRes = await request(app)
        .post('/view')
        .send({ title: 'HTML Test', markdown: '# Heading\n\nParagraph.' })
        .expect(201);

      const viewId = createRes.body.id;

      const res = await request(app)
        .get(`/view/${viewId}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain('<title>HTML Test</title>');
      expect(res.text).toContain('Heading');
      expect(res.text).toContain('Paragraph');
    });

    it('returns 404 for non-existent view', async () => {
      await request(app)
        .get('/view/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });

    it('rejects invalid view ID format', async () => {
      await request(app)
        .get('/view/not-a-uuid')
        .expect(400);
    });
  });

  describe('PIN-protected views', () => {
    let pinViewId: string;

    it('creates a PIN-protected view', async () => {
      const res = await request(app)
        .post('/view')
        .send({ title: 'Secret Report', markdown: 'Top secret content.', pin: '9876' })
        .expect(201);

      pinViewId = res.body.id;
      expect(res.body.pinProtected).toBe(true);
    });

    it('GET /view/:id shows PIN page for protected views', async () => {
      const res = await request(app)
        .get(`/view/${pinViewId}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('PIN-protected');
      expect(res.text).toContain('Unlock');
      // Should NOT contain the actual content
      expect(res.text).not.toContain('Top secret content');
    });

    it('POST /view/:id/unlock with correct PIN returns content', async () => {
      const res = await request(app)
        .post(`/view/${pinViewId}/unlock`)
        .send({ pin: '9876' })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Secret Report');
      expect(res.text).toContain('Top secret content');
    });

    it('POST /view/:id/unlock with wrong PIN returns 403', async () => {
      const res = await request(app)
        .post(`/view/${pinViewId}/unlock`)
        .send({ pin: '0000' })
        .expect(403);

      expect(res.body.error).toContain('Incorrect PIN');
    });

    it('POST /view/:id/unlock without PIN returns 400', async () => {
      await request(app)
        .post(`/view/${pinViewId}/unlock`)
        .send({})
        .expect(400);
    });

    it('rejects PIN shorter than 4 characters', async () => {
      const res = await request(app)
        .post('/view')
        .send({ title: 'Short PIN', markdown: 'content', pin: '12' })
        .expect(400);

      expect(res.body.error).toContain('pin');
    });

    it('non-PIN views do not show PIN page', async () => {
      const createRes = await request(app)
        .post('/view')
        .send({ title: 'Open View', markdown: 'Public content' })
        .expect(201);

      expect(createRes.body.pinProtected).toBeFalsy();

      const res = await request(app)
        .get(`/view/${createRes.body.id}`)
        .expect(200);

      expect(res.text).toContain('Public content');
      expect(res.text).not.toContain('PIN-protected');
    });
  });

  describe('GET /views', () => {
    it('returns list of all views', async () => {
      const res = await request(app)
        .get('/views')
        .expect(200);

      expect(res.body.views).toBeInstanceOf(Array);
      expect(res.body.views.length).toBeGreaterThan(0);

      const view = res.body.views[0];
      expect(view.id).toBeTruthy();
      expect(view.title).toBeTruthy();
      expect(view.localUrl).toMatch(/^\/view\//);
    });
  });

  describe('PUT /view/:id', () => {
    it('updates an existing view', async () => {
      const createRes = await request(app)
        .post('/view')
        .send({ title: 'Original', markdown: 'Old content' })
        .expect(201);

      const viewId = createRes.body.id;

      const updateRes = await request(app)
        .put(`/view/${viewId}`)
        .send({ title: 'Updated', markdown: 'New content' })
        .expect(200);

      expect(updateRes.body.title).toBe('Updated');
      expect(updateRes.body.updatedAt).toBeTruthy();

      // Verify HTML reflects the update
      const htmlRes = await request(app)
        .get(`/view/${viewId}`)
        .expect(200);

      expect(htmlRes.text).toContain('<title>Updated</title>');
      expect(htmlRes.text).toContain('New content');
    });

    it('returns 404 for non-existent view', async () => {
      await request(app)
        .put('/view/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Test', markdown: 'content' })
        .expect(404);
    });
  });

  describe('DELETE /view/:id', () => {
    it('deletes an existing view', async () => {
      const createRes = await request(app)
        .post('/view')
        .send({ title: 'Delete Me', markdown: 'content' })
        .expect(201);

      const viewId = createRes.body.id;

      await request(app)
        .delete(`/view/${viewId}`)
        .expect(200);

      // Verify it's gone
      await request(app)
        .get(`/view/${viewId}`)
        .expect(404);
    });

    it('returns 404 for non-existent view', async () => {
      await request(app)
        .delete('/view/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  describe('GET /tunnel', () => {
    it('reports tunnel as disabled when no tunnel configured', async () => {
      const res = await request(app)
        .get('/tunnel')
        .expect(200);

      expect(res.body.enabled).toBe(false);
      expect(res.body.url).toBeNull();
    });
  });

  describe('GET /capabilities', () => {
    it('reports privateViewer as enabled', async () => {
      const res = await request(app)
        .get('/capabilities')
        .expect(200);

      expect(res.body.privateViewer).toBeDefined();
      expect(res.body.privateViewer.enabled).toBe(true);
      expect(res.body.privateViewer.viewCount).toBeGreaterThan(0);
    });

    it('reports tunnel as disabled', async () => {
      const res = await request(app)
        .get('/capabilities')
        .expect(200);

      expect(res.body.tunnel).toBeDefined();
      expect(res.body.tunnel.enabled).toBe(false);
    });
  });
});
