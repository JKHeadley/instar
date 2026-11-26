/**
 * SEC-164 part 1b regression: building the routes from a context with no project folder must not throw.
 *
 * Part 1b builds the credential-scrub switch reader while the routes are assembled. Before the fix the
 * reader joined `undefined` into a path and threw, so every server built from a minimal context (most
 * end-to-end lifecycle tests, and some unit route tests) lost all of its routes (Local Verify 3637,
 * 158 end-to-end failures). With no folder the switch is off, exactly as for an unreadable settings file.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialScrubEnabledReader } from '../../src/core/outputCredentialScrub.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('credentialScrubEnabledReader with no project folder', () => {
  it('does not throw and reports the switch as off', () => {
    for (const dir of [undefined, null, '']) {
      const read = credentialScrubEnabledReader(dir as never);
      expect(read()).toBe(false);
    }
  });

  it('still reads a real settings file when a folder is given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-reader-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'));
      fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ security: { credentialScrub: { enabled: true } } }));
      expect(credentialScrubEnabledReader(dir)()).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec164-reader-no-project-dir.test.ts' });
    }
  });
});

describe('createRoutes from a minimal context (no projectDir)', () => {
  it('builds without throwing', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-routes-'));
    try {
      const ctx: any = { config: { authToken: 'test', stateDir, port: 0 }, startTime: new Date() };
      const app = express();
      expect(() => app.use(createRoutes(ctx))).not.toThrow();
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/sec164-reader-no-project-dir.test.ts' });
    }
  });
});
