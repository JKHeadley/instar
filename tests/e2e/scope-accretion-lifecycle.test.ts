// safe-git-allow: test-tmpdir-cleanup — afterAll removes per-test mkdtempSync dirs.
/**
 * E2E (Tier 3) — Scope-Accretion Completion Discipline is ALIVE end-to-end.
 * Spec: autonomous-scope-accretion-completion.md §5.
 *
 * Reproduces the motivating incident in miniature over a REAL HTTP server
 * (real listen + fetch, real createRoutes, real AutonomousRunStore on disk,
 * real git repo as the run's work_dir):
 *
 *   1. The run registers (as setup-autonomous.sh does) → server-minted runId.
 *   2. The session creates docs/specs/incident-shape.md VIA BASH HEREDOC (the
 *      required evasion-shaped case — no Write/Edit tool event exists) and
 *      presents a met-looking transcript → the chokepoint HOLDS (met:false,
 *      scope-accretion-hold) — the incident's silent exit is impossible.
 *   3. The REAL ceremony evidence path (R32): the conformance-check route is
 *      called (as spec-converge does), the invocation is persisted server-side,
 *      the convergence report exists → corroboration clears the spec → the
 *      judge runs → met:true → the record goes terminal.
 *
 *   Breaker lifecycle: K unchanged holds trip ONE loud labeled exit
 *   (attention + topic notice carrying the P13 classification), after which
 *   the gate disengages (no wedge) — R26/R39/R40.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { createSpecReviewRoutes } from '../../src/server/specReviewRoutes.js';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const PIN = '565656';
const CONDITION = 'the incident-shape feature is verifiably shipped';

let stateDir: string;
let repo: string;
let server: Server;
let base: string;
const sends: Array<{ topicId: number; text: string }> = [];
const attention: Array<Record<string, unknown>> = [];

const stubJudge: IntelligenceProvider = {
  async evaluate(prompt: string) {
    // The P13 classification call (breaker trip) answers STOP_OK/STOP_BLOCKED;
    // the completion judge answers MET/NOT_MET. Discriminate on the RESPONSE
    // INSTRUCTION line (the completion prompt's anti-injection fence text also
    // mentions 'respond STOP_OK' in single quotes — a bare substring match on
    // STOP_OK misroutes completion calls to the rationale answer).
    if (prompt.includes('exactly "STOP_OK"')) return 'STOP_BLOCKED\nbuildable — the specs can be built now';
    return 'MET\nthe transcript shows the shipped evidence';
  },
};

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd });
}

async function post(p: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sa-e2e-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sa-e2e-repo-'));
  git(['init', '-q', '.'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);

  const ctx = {
    completionEvaluator: new CompletionEvaluator({ intelligence: stubJudge }),
    telegram: {
      onScopeAccretionInbound: null as unknown,
      async sendToTopic(topicId: number, text: string) {
        sends.push({ topicId, text });
        return { messageId: 700 + sends.length };
      },
      async createAttentionItem(item: Record<string, unknown>) {
        attention.push(item);
        return item;
      },
    },
    topicOperatorStore: null,
    featureMetricsLedger: null,
    config: {
      authToken: 'test',
      dashboardPin: PIN,
      stateDir,
      projectDir: stateDir,
      port: 0,
      sessions: { maxSessions: 5 },
      autonomousSessions: {
        completionDiscipline: { scopeAccretion: { enabled: true, breakerK: 2 } },
        maxDurationMs: 48 * 3_600_000,
      },
    },
    stateDir,
  } as unknown as Parameters<typeof createRoutes>[0];

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(createRoutes(ctx));
  // The REAL conformance-check surface — its persistence hook is the R32
  // ceremony-evidence chokepoint (same stateDir as the run store).
  app.use(createSpecReviewRoutes({
    intelligence: {
      async evaluate() {
        return '[]';
      },
    },
    registryPath: path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md'),
    specsDir: path.join(repo, 'docs', 'specs'),
    stateDir,
  }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('E2E: the incident shape is structurally impossible', () => {
  let runId = '';

  it('feature is ALIVE: registration answers 200 with a server-minted runId', async () => {
    const res = await post('/autonomous/register', {
      topicId: '29836',
      condition: CONDITION,
      workDir: repo,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      endAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(String(res.body.runId)).toMatch(/^run-/);
    runId = String(res.body.runId);
  });

  it('a Bash-heredoc-created spec + a met-looking transcript does NOT exit (the hold)', async () => {
    fs.mkdirSync(path.join(repo, 'docs', 'specs'), { recursive: true });
    // The REQUIRED evasion-shaped case: a heredoc write produces NO tool event.
    execFileSync('bash', ['-c', "cat > docs/specs/incident-shape.md <<'EOF'\n# Incident-shape spec\nDrafted by the run itself.\nEOF"], { cwd: repo });

    const res = await post('/autonomous/evaluate-completion', {
      condition: CONDITION,
      transcriptTail: 'All ten condition items are surfaced. The implementation of the drafted spec is the documented stretch (out of completion condition). Condition met.',
      topicId: '29836',
      runId,
    });
    expect(res.status).toBe(200);
    expect(res.body.met).toBe(false);
    expect(String(res.body.reason)).toContain('scope-accretion-hold');
    expect(String(res.body.reason)).toContain('docs/specs/incident-shape.md');
  });

  it('the REAL ceremony evidence (R32) clears the spec: conformance-check invocation + report → met', async () => {
    // 1. The ceremony calls the REAL conformance-check route (persistence hook).
    const check = await post('/spec/conformance-check', {
      markdown: `---\ntitle: x\nslug: incident-shape\nparent-principle: "Structure > Willpower"\n---\n# Incident-shape spec\nbody`,
    });
    expect(check.status).toBe(200);
    // 2. The convergence report artifact exists at the canonical path.
    fs.mkdirSync(path.join(repo, 'docs', 'specs', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'specs', 'reports', 'incident-shape-convergence.md'), '# converged\n');

    const res = await post('/autonomous/evaluate-completion', {
      condition: CONDITION,
      transcriptTail: 'Converged and shipped; report committed.',
      topicId: '29836',
      runId,
    });
    expect(res.body.met).toBe(true);

    // Terminal (R43): the record is met — a fresh registration succeeds.
    const again = await post('/autonomous/register', {
      topicId: '29836',
      condition: CONDITION,
      workDir: repo,
      startedAt: new Date().toISOString(),
    });
    expect(again.status).toBe(200);
  });
});

describe('E2E: breaker exit is LOUD, labeled, and non-wedging (R26/R39/R40)', () => {
  it('K=2 unchanged holds → ONE labeled attention item + topic notice with the P13 classification, then the exit', async () => {
    const reg = await post('/autonomous/register', {
      topicId: '29900',
      condition: 'breaker lifecycle test condition',
      workDir: repo,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const runId = String(reg.body.runId);
    execFileSync('bash', ['-c', "cat > docs/specs/breaker-shape.md <<'EOF'\n# breaker\nEOF"], { cwd: repo });

    const claim = () => post('/autonomous/evaluate-completion', {
      condition: 'breaker lifecycle test condition',
      transcriptTail: 'done, condition met',
      topicId: '29900',
      runId,
    });
    const h1 = await claim();
    expect(h1.body.met).toBe(false); // hold 1
    const h2 = await claim(); // hold 2 = K → trip → gate disengages → judge MET
    expect(h2.body.met).toBe(true);

    const trip = attention.find((a) => String(a.id) === `scope-accretion-breaker-29900-${runId}`);
    expect(trip).toBeDefined();
    expect(String(trip!.summary)).toContain('exiting via scope-accretion breaker');
    expect(String(trip!.summary)).toContain('docs/specs/breaker-shape.md');
    expect(String(trip!.summary)).toContain('P13 classification: buildable'); // the evasion shape is DISPLAYED
    const notice = sends.find((s) => s.topicId === 29900 && s.text.includes('scope-accretion breaker'));
    expect(notice).toBeDefined();
  });
});

describe('E2E: every exit is loud (R40/R44 run-end surface)', () => {
  it('a duration-expiry run-end enumerates unbuilt accreted work in the end-of-run notice', async () => {
    const reg = await post('/autonomous/register', {
      topicId: '29901',
      condition: 'clock-out lifecycle test',
      workDir: repo,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    execFileSync('bash', ['-c', "cat > docs/specs/clockout-shape.md <<'EOF'\n# clockout\nEOF"], { cwd: repo });
    const res = await post('/autonomous/29901/run-end', { reason: 'duration-expiry', runId: String(reg.body.runId) });
    expect(res.status).toBe(200);
    expect(Number(res.body.unbuiltEnumerated)).toBeGreaterThan(0);
    const notice = sends.find((s) => s.topicId === 29901 && s.text.includes('clockout-shape.md'));
    expect(notice).toBeDefined();
    expect(attention.some((a) => String(a.id).startsWith('scope-accretion-exit-29901-'))).toBe(true);
  });
});
