/**
 * Integration regression tests for the /tokens 503 recovery paths.
 *
 * These exercise a real TokenLedger plus the Express token route against
 * throwaway SQLite files so the test proves the endpoint is alive after
 * the two observed failure classes:
 *   - pre-attribution DB schema missing token_events.attribution_key
 *   - a prior successful native-module heal consumed by another subsystem
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { NativeModuleHealer } from '../../src/memory/NativeModuleHealer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-token-503-regression-'));
}

function seedPreAttributionDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE token_events (
        request_id            TEXT PRIMARY KEY,
        uuid                  TEXT,
        session_id            TEXT NOT NULL,
        project_path          TEXT,
        ts                    INTEGER NOT NULL,
        model                 TEXT,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        service_tier          TEXT
      );
      INSERT INTO token_events
        (request_id, uuid, session_id, project_path, ts, model,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, service_tier)
      VALUES
        ('req-old-1', 'uuid-old-1', 'sess-old', '/tmp/old-project', 1800000000000,
         'claude-opus-4-7', 10, 20, 3, 7, 'standard');
    `);
  } finally {
    db.close();
  }
}

function ctxWithLedger(ledger: TokenLedger | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: ledger,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWithLedger(ledger: TokenLedger): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWithLedger(ledger)));
  return app;
}

describe('Token ledger 503 recovery paths (integration)', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    NativeModuleHealer.resetForTesting();
    for (const dir of cleanupDirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tokens-503-regression.test.ts:cleanup',
      });
    }
  });

  it('keeps /tokens/summary alive when opening an old pre-attribution DB', async () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, 'tokens.sqlite');
    seedPreAttributionDb(dbPath);

    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: path.join(dir, 'claude-projects') });
    try {
      const res = await request(appWithLedger(ledger))
        .get('/tokens/summary')
        .query({ since: '0' });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.summary.eventCount).toBe(1);
      expect(res.body.summary.totalTokens).toBe(40);

      const migrated = new Database(dbPath);
      try {
        const columns = migrated.pragma('table_info(token_events)') as Array<{ name: string }>;
        expect(columns.map(c => c.name)).toContain('attribution_key');
      } finally {
        migrated.close();
      }
    } finally {
      ledger.close();
    }
  });

  it('keeps /tokens/summary alive when TokenLedger opens after another subsystem already healed sqlite', async () => {
    const dir = makeTempDir();
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, 'tokens.sqlite');
    seedPreAttributionDb(dbPath);

    const healSpy = vi
      .spyOn(NativeModuleHealer, 'healBetterSqlite3Sync')
      .mockImplementation(function (this: any, component: string) {
        (NativeModuleHealer as any).healAttempted = true;
        (NativeModuleHealer as any).lastResult = {
          component,
          timestamp: new Date().toISOString(),
          success: true,
          nodeVersion: process.version,
          durationMs: 1,
        };
        return true;
      });

    let semanticOpenAttempts = 0;
    const semanticResult = NativeModuleHealer.openWithHealSync('SemanticMemory', () => {
      semanticOpenAttempts += 1;
      if (semanticOpenAttempts === 1) {
        throw new Error('NODE_MODULE_VERSION 141 requires NODE_MODULE_VERSION 127');
      }
      return 'semantic-opened';
    });
    expect(semanticResult).toBe('semantic-opened');
    expect(healSpy).toHaveBeenCalledTimes(1);

    let tokenOpenAttempts = 0;
    const ledger = new TokenLedger({
      dbPath,
      claudeProjectsDir: path.join(dir, 'claude-projects'),
      databaseFactory: (pathToOpen) => {
        tokenOpenAttempts += 1;
        if (tokenOpenAttempts === 1) {
          throw new Error('NODE_MODULE_VERSION 141 requires NODE_MODULE_VERSION 127');
        }
        return new Database(pathToOpen);
      },
    });

    try {
      expect(tokenOpenAttempts).toBe(2);
      expect(healSpy).toHaveBeenCalledTimes(1);

      const res = await request(appWithLedger(ledger))
        .get('/tokens/summary')
        .query({ since: '0' });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.summary.eventCount).toBe(1);
      expect(res.body.summary.totalTokens).toBe(40);
    } finally {
      ledger.close();
    }
  });
});
