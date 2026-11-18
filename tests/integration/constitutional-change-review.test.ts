import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { createSpecReviewRoutes } from '../../src/server/specReviewRoutes.js';
import { resolveStandardsRegistryFromPath } from '../../src/core/standardsRegistryPath.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('constitutional change review through the existing HTTP consumer', () => {
  let root = '';
  afterEach(() => { if (root) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'constitutional-review-route-test:cleanup' }); });
  it('delivers the complete governing pair, preserves a master-only citation, and identifies the exact checker', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-route-'));
    let seen = '';
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use(createSpecReviewRoutes({ stateDir: root, specsDir: root,
      registryResolution: resolveStandardsRegistryFromPath(path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md')),
      intelligence: { frameworkId: 'fixture-provider', async evaluate(prompt) { seen = prompt; return '[{"standard":"Rule 118","reason":"A required second provider removes core functionality."}]'; } },
    }));
    const identity = await request(app).get('/spec/conformance-metrics');
    expect(identity.body.context.governing.available).toBe(true);
    const result = await request(app).post('/spec/conformance-check').send({ markdown: '# Change\nRequire a second provider to use this feature.' });
    expect(result.status).toBe(200);
    expect(result.body.report.degraded).toBe(false);
    expect(result.body.report.governing.identity).toBe(identity.body.context.governing.identity);
    expect(result.body.report.checkerIdentity).toBe(identity.body.context.checkerIdentity);
    expect(result.body.report.findings[0]).toMatchObject({ standard: 'Rule 118: One Provider Is Enough', citationResolved: true, declarationKind: 'Rule' });
    expect(seen).toContain('Make coherence something an AI cannot lose');
    expect(seen).toContain('One Provider Is Enough');
    expect(seen).not.toContain('…[truncated]');
  });
});
