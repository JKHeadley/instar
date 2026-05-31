/**
 * E2E lifecycle test — Preferences dashboard tab (Correction & Preference
 * Learning Sentinel, §10 Slice-2).
 *
 * Boots a REAL Express server with the inline /preferences/session-context +
 * /corrections routes from createRoutes() (the production path AgentServer uses),
 * mounts the tab markup in jsdom with the SHIPPED element ids, and drives the
 * SHIPPED controller's fetchImpl against the live HTTP server. Asserts the
 * feature is genuinely alive end-to-end:
 *   - feature ON: loads → renders the learned preferences + scrubbed corrections;
 *     the raw `learning` text NEVER reaches the DOM (toApiView strips it).
 *   - feature OFF (ledger absent / config disabled → 503): pinned disabled copy,
 *     NO config-key string and NO monospace/<code> element anywhere.
 */
// @ts-nocheck — the tab controller is browser-native ESM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { createController } from '../../dashboard/preferences-learning.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'prefs-tab-e2e-token';

function ctxWith(stateDir: string, ledger: CorrectionLedger | null, enabled: boolean): RouteContext {
  return {
    config: {
      projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH,
      monitoring: { correctionLearning: { enabled } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, correctionLedger: ledger, startTime: new Date(),
  } as unknown as RouteContext;
}

// The real tab panel markup (mirrors dashboard/index.html element ids).
const PANEL_HTML = `<!doctype html><body>
  <div id="preferencesLearningPanel" class="ph-root">
    <div id="plStamp" class="ph-stamp"></div>
    <div id="plHeadline" class="ph-headline-wrap"></div>
    <div id="plPreferences"></div>
    <div id="plCorrections"></div>
  </div>
</body>`;

function mountTab(baseUrl: string) {
  const doc = new JSDOM(PANEL_HTML).window.document;
  const els = {
    headline: doc.getElementById('plHeadline'),
    preferences: doc.getElementById('plPreferences'),
    corrections: doc.getElementById('plCorrections'),
    stamp: doc.getElementById('plStamp'),
  };
  const fetchImpl = (p: string, opts: any = {}) => fetch(`${baseUrl}${p}`, {
    headers: { Authorization: `Bearer ${AUTH}`, ...(opts.headers || {}) },
    signal: opts.signal,
  });
  const c = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
  return { doc, els, c, panel: doc.getElementById('preferencesLearningPanel') };
}

describe('E2E: Preferences tab — feature ON', () => {
  let ledger: CorrectionLedger;
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;
  let stateDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-tab-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    // A learned preference on disk — the tab must surface it in plain language.
    const prefs = new PreferencesManager(stateDir);
    prefs.recordPreference({
      learning: 'Lead with the one action, no preamble.',
      dedupeKey: CorrectionLedger.dedupeKey('user-preference', 'lead with the one action'),
      confidence: 0.8,
    });

    // A scrubbed correction record — the tab must surface its summary, never raw.
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'e2ebox' });
    ledger.record({
      kind: 'infra-gap',
      learning: 'RAW-LEARNING-MUST-NOT-LEAK-TO-DOM',
      scrubbedSummary: 'force-push nag every session',
      deterministicWeight: 3,
      topicId: 7,
    });

    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctxWith(stateDir, ledger, true)));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    ledger.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/preferences-learning-tab-lifecycle.test.ts:afterAll' });
  });

  it('the endpoints are alive (200) on the production route path', async () => {
    const prefsRes = await fetch(`${baseUrl}/preferences/session-context`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(prefsRes.status).toBe(200);
    const corrRes = await fetch(`${baseUrl}/corrections`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(corrRes.status).toBe(200);
  });

  it('loads + renders the learned preference and scrubbed correction; raw learning never leaks', async () => {
    const { c, els, panel } = mountTab(baseUrl);
    c.start();
    await c.tick();
    expect(els.headline.textContent).toMatch(/1 preference I've picked up/i);
    expect(els.preferences.textContent).toContain('Lead with the one action');
    expect(els.corrections.textContent).toContain('force-push nag every session');
    // The redaction contract holds end-to-end: the raw learning is absent.
    expect(panel.textContent).not.toContain('RAW-LEARNING-MUST-NOT-LEAK-TO-DOM');
    c.stop();
  });

  it('refreshes: a newly recorded correction shows up on the next tick', async () => {
    const { c, els } = mountTab(baseUrl);
    c.start();
    await c.tick();
    ledger.record({ kind: 'user-preference', learning: 'x', scrubbedSummary: 'prefers no tables in chat', deterministicWeight: 3, topicId: 7 });
    await c.tick();
    expect(els.corrections.textContent).toContain('prefers no tables in chat');
    c.stop();
  });
});

describe('E2E: Preferences tab — feature OFF (503)', () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-tab-off-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    // ledger absent + config disabled → both endpoints 503.
    app.use('/', createRoutes(ctxWith(stateDir, null, false)));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/preferences-learning-tab-lifecycle.test.ts:afterAll-off' });
  });

  it('both endpoints 503 when disabled', async () => {
    const prefsRes = await fetch(`${baseUrl}/preferences/session-context`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(prefsRes.status).toBe(503);
    const corrRes = await fetch(`${baseUrl}/corrections`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(corrRes.status).toBe(503);
  });

  it('renders the friendly disabled copy — NO config-key string, NO monospace/<code> anywhere', async () => {
    const { c, els, panel } = mountTab(baseUrl);
    c.start();
    await c.tick();
    expect(els.headline.textContent).toMatch(/isn't turned on/i);
    expect(els.headline.textContent).not.toMatch(/Connection paused|can't refresh/i);
    // No leaked config key.
    expect(panel.textContent).not.toContain('correctionLearning');
    expect(panel.textContent).not.toContain('monitoring.');
    // No monospace/code element anywhere in the tab (incl. expanded operator hint).
    const operator = panel.querySelector('.ph-operator');
    if (operator) operator.setAttribute('open', '');
    expect(panel.querySelectorAll('code,pre,kbd,samp,tt').length).toBe(0);
    c.stop();
  });
});
