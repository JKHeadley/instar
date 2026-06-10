// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 3 (E2E "feature is alive") test for Cartographer Subtree Navigation
 * (cartographer-subtree-nav spec #5).
 *
 * The single most important test: it proves the navigator is genuinely alive
 * end-to-end — the route is wired to a REAL CartographerTree (not a null/no-op),
 * /cartographer/navigate returns 200 (not 503), and over a REAL fixture git repo
 * with a scaffolded + AUTHORED tree, a query for a known subsystem returns that
 * subsystem's paths as relevantPaths and EXCLUDES unrelated subtrees. A no-op or
 * mis-wired navigator fails this immediately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CartographerTree } from '../../src/core/CartographerTree.js';

const AUTH = 'test-bearer-token';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string;
let stateDir: string;
let carto: CartographerTree;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-nav-e2e-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  // Two clearly-distinct subsystems.
  fs.mkdirSync(path.join(repo, 'src', 'messaging'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'messaging', 'TelegramAdapter.ts'), 'export class TelegramAdapter {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'messaging', 'MessageRouter.ts'), 'export class MessageRouter {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'billing', 'InvoiceEngine.ts'), 'export class InvoiceEngine {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'billing', 'PaymentProcessor.ts'), 'export class PaymentProcessor {}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  carto = new CartographerTree({ projectDir: repo, stateDir });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  a.use('/', createRoutes({
    config: { projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    cartographer: carto,
    startTime: new Date(),
  } as unknown as RouteContext));
  return a;
}
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

describe('Cartographer Subtree Navigation — feature is alive (Tier 3 E2E)', () => {
  it('navigate route is wired and returns 200 (not 503) with a manifest', async () => {
    const res = await bearer(request(app()).get('/cartographer/navigate?query=telegram'));
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('telegram');
    expect(Array.isArray(res.body.relevantPaths)).toBe(true);
  });

  it('over a scaffolded + authored tree, a subsystem query scopes to that subsystem and excludes unrelated subtrees', async () => {
    const a = app();
    // scaffold + author both subsystems with realistic plain-language summaries.
    carto.scaffold();
    carto.setSummary('src/messaging', 'messaging platform adapters: the TelegramAdapter and MessageRouter');
    carto.setSummary('src/messaging/TelegramAdapter.ts', 'the TelegramAdapter long-polls Telegram and relays messages');
    carto.setSummary('src/messaging/MessageRouter.ts', 'the MessageRouter routes a topic to its messaging adapter');
    carto.setSummary('src/billing', 'billing subsystem: the InvoiceEngine and PaymentProcessor');
    carto.setSummary('src/billing/InvoiceEngine.ts', 'the InvoiceEngine generates invoices');
    carto.setSummary('src/billing/PaymentProcessor.ts', 'the PaymentProcessor charges a card via the gateway');

    const res = await bearer(request(a).get('/cartographer/navigate?query=telegram+messaging+adapter+routing'));
    expect(res.status).toBe(200);

    const relevant = res.body.relevantPaths as string[];
    const flat = relevant.join('|');
    // The messaging subsystem is scoped in (as the dir or its leaves).
    expect(flat).toMatch(/src\/messaging/);
    // The unrelated billing subsystem is NOT scoped in.
    expect(flat).not.toMatch(/billing/);

    // The manifest is summary-informed (we authored summaries) — coverage > 0.
    expect(res.body.summaryCoverage).toBeGreaterThan(0);
    // And it actually scored real nodes (proves it walked a real tree, not a no-op).
    expect(res.body.scored.length).toBeGreaterThan(0);
  });

  it('the relevant messaging dir collapses (both its leaves match) — minimal covering subtree', async () => {
    const a = app();
    carto.scaffold();
    carto.setSummary('src/messaging', 'messaging adapters');
    carto.setSummary('src/messaging/TelegramAdapter.ts', 'the TelegramAdapter handles Telegram messaging');
    carto.setSummary('src/messaging/MessageRouter.ts', 'the MessageRouter routes messaging by topic');
    carto.setSummary('src/billing/InvoiceEngine.ts', 'the InvoiceEngine generates invoices');

    const res = await bearer(request(a).get('/cartographer/navigate?query=TelegramAdapter+MessageRouter+messaging'));
    expect(res.status).toBe(200);
    const relevant = res.body.relevantPaths as string[];
    // Collapsed: the dir replaces its two relevant leaves.
    expect(relevant).toContain('src/messaging');
    expect(relevant).not.toContain('src/messaging/TelegramAdapter.ts');
  });
});
