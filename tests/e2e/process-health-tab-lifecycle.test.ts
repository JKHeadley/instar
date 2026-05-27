/**
 * E2E lifecycle test — Process Health dashboard tab (spec §6.3).
 *
 * Boots a REAL Express server with the inline /failures routes from
 * createRoutes() (the production path AgentServer uses), mounts the tab markup
 * in jsdom with the SHIPPED element ids, and drives the SHIPPED controller's
 * fetchImpl against the live HTTP server. Asserts the feature is genuinely alive
 * end-to-end:
 *   - feature ON: loads → renders → refreshes; detail.full never leaks to the DOM
 *   - rollout.stage is one of dark/capture-only/insight-push (never a 4th value);
 *     the maturation 4th step renders as a future glyph, never "you're here"
 *   - feature OFF (ledger absent → 503): pinned disabled copy, NO config-key
 *     string and NO monospace/<code> element anywhere (incl. operator hint)
 */
// @ts-nocheck — the tab controller is browser-native ESM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { JSDOM } from 'jsdom';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../../src/monitoring/FailureAttributionEngine.js';
import { createController } from '../../dashboard/process-health.js';

function ctxWith(extra: Partial<RouteContext>, fl?: unknown): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any, monitoring: { failureLearning: fl } } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
    ...extra,
  } as RouteContext;
}

// The real tab panel markup (mirrors dashboard/index.html element ids).
const PANEL_HTML = `<!doctype html><body>
  <div id="processHealthPanel" class="ph-root">
    <div id="phStamp" class="ph-stamp"></div>
    <div id="phHeadline" class="ph-headline-wrap"></div>
    <div id="phPatterns"></div>
    <div id="phCaptured"></div>
    <div id="phMaturation"></div>
    <div id="phDetail" class="ph-detail-body"></div>
  </div>
</body>`;

function mountTab(baseUrl: string) {
  const doc = new JSDOM(PANEL_HTML).window.document;
  const els = {
    headline: doc.getElementById('phHeadline'),
    patterns: doc.getElementById('phPatterns'),
    captured: doc.getElementById('phCaptured'),
    maturation: doc.getElementById('phMaturation'),
    detail: doc.getElementById('phDetail'),
    stamp: doc.getElementById('phStamp'),
  };
  // Real HTTP fetch to the live server (the controller passes relative paths).
  const fetchImpl = (path: string, opts: any = {}) => fetch(`${baseUrl}${path}`, { headers: opts.headers, signal: opts.signal });
  // No real timers in the test — we drive ticks manually.
  const c = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
  return { doc, els, c, panel: doc.getElementById('processHealthPanel') };
}

describe('E2E: Process Health tab — feature ON', () => {
  let ledger: FailureLedger;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'e2ebox' });
    // Seed a captured failure — its detail.full MUST never reach the tab DOM.
    ledger.open({
      filedBy: 's1', source: 'bugfix-commit', severity: 'medium',
      summary: 'a data race in the reconciler', detail: { redacted: 'race in <module>', full: 'race in src/secret/Reconciler.ts:88' },
      category: 'concurrency', initiativeId: 'failure-learning-loop', causeCommitOid: 'c1', attribution: 'automatic', attributionConfidence: 0.9,
    });
    const engine = new FailureAttributionEngine({
      getInitiative: (id) => (id === 'failure-learning-loop' ? { id, parentProjectId: 'p', specPath: 'docs/specs/x.md' } : null),
      commitTouchedFiles: () => [],
    });
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith({ failureLedger: ledger, failureAttributionEngine: engine }, { enabled: true })));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(() => { server?.close(); ledger.close(); });

  it('loads + renders from the live server, and detail.full never leaks to the DOM', async () => {
    const { c, els, panel } = mountTab(baseUrl);
    c.start();
    await c.tick();
    expect(els.headline.textContent).toContain('Watching — 1 issue recorded');
    expect(els.captured.textContent).toContain('A concurrency issue');
    expect(els.captured.textContent).toContain('the failure-learning loop'); // friendly label, not raw id
    expect(els.captured.textContent).not.toContain('failure-learning-loop');
    // The redaction contract holds end-to-end: the full path is absent from the DOM.
    expect(panel.textContent).not.toContain('secret/Reconciler');
    c.stop();
  });

  it('rollout.stage is one of dark/capture-only/insight-push; 4th maturation step is future, never "here"', async () => {
    const res = await fetch(`${baseUrl}/failures/analysis`);
    const body = await res.json();
    expect(['dark', 'capture-only', 'insight-push']).toContain(body.rollout.stage);
    expect(body.rollout.stage).toBe('capture-only'); // enabled:true, no insight escalation

    const { c, els } = mountTab(baseUrl);
    c.start();
    await c.tick();
    const stages = [...els.maturation.querySelectorAll('.ph-stage')];
    const last = stages[stages.length - 1];
    expect(last.textContent).toContain('Default for all agents');
    expect(last.textContent).not.toContain('you’re here');
    expect(last.classList.contains('ph-stage-here')).toBe(false);
    c.stop();
  });

  it('refreshes: a newly captured failure shows up on the next tick', async () => {
    const { c, els } = mountTab(baseUrl);
    c.start();
    await c.tick();
    expect(els.headline.textContent).toContain('Watching — 1 issue recorded');
    ledger.open({
      filedBy: 's2', source: 'bugfix-commit', severity: 'low',
      summary: 'a config typo', detail: { redacted: 'typo', full: 'typo' },
      category: 'config-parse', initiativeId: 'failure-learning-loop', causeCommitOid: 'c2', attribution: 'automatic',
    });
    await c.tick();
    expect(els.headline.textContent).toContain('Watching — 2 issues recorded');
    c.stop();
  });
});

describe('E2E: Process Health tab — feature OFF (503)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // ledger absent → every /failures route 503s.
    app.use('/', createRoutes(ctxWith({ failureLedger: null, failureAttributionEngine: null }, { enabled: false })));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(() => { server?.close(); });

  it('renders the pinned disabled copy — NO config-key string, NO monospace/<code> anywhere', async () => {
    const { c, els, panel } = mountTab(baseUrl);
    c.start();
    await c.tick();
    expect(els.headline.textContent).toContain('isn’t turned on');
    expect(els.headline.textContent).not.toContain('Connection paused');
    // No leaked config key (§4.5).
    expect(panel.textContent).not.toContain('failureLearning');
    expect(panel.textContent).not.toContain('monitoring.');
    // No monospace/code element anywhere in the tab, including the expanded operator hint.
    const operator = panel.querySelector('.ph-operator');
    if (operator) operator.setAttribute('open', ''); // expand the operator <details>
    expect(panel.querySelectorAll('code,pre,kbd,samp,tt').length).toBe(0);
    c.stop();
  });
});
