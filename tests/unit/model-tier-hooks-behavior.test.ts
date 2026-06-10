// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Behavioral tests for the two §5.4 signal hooks (FABLE-MODEL-ESCALATION-SPEC)
 * — the shipped template files are EXECUTED for real (bash/node child
 * process), not parsed. This is the §11 wiring-integrity sweep for the hook
 * layer: "reconciler registered + non-noop; skill-entry writes only on
 * transition". Registration is covered by the migrator parity tests; these
 * prove the hooks DO the right thing when they fire.
 *
 * Both hooks are SIGNAL-ONLY: the skill-entry writes the per-instance
 * mode-state; the reconciler computes desired-vs-applied and (only on a
 * transition) POSTs the server-side swap authority. Neither ever swaps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SKILL_ENTRY = path.join(REPO_ROOT, 'src/templates/hooks/model-tier-skill-entry.sh');
const RECONCILER = path.join(REPO_ROOT, 'src/templates/hooks/model-tier-reconciler.js');

const havePython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

const SID = 'inst-test-1';

function writeConfig(projectDir: string, tierEscalation: Record<string, unknown>): void {
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.instar', 'config.json'),
    JSON.stringify({ models: { tierEscalation } }, null, 2),
  );
}

function stateDirOf(projectDir: string): string {
  return path.join(projectDir, '.instar', 'state', 'model-tier-escalation');
}

function modeFileOf(projectDir: string, sid = SID): string {
  return path.join(stateDirOf(projectDir), `mode-state-${sid}.json`);
}

function markerFileOf(projectDir: string, sid = SID): string {
  return path.join(stateDirOf(projectDir), `last-applied-${sid}.json`);
}

describe.skipIf(!havePython)('model-tier-skill-entry.sh — write-on-transition signal', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tier-skill-entry-'));
    writeConfig(projectDir, { enabled: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/model-tier-hooks-behavior.test.ts' });
  });

  function runHook(opts: { skill?: string; toolName?: string; sid?: string | null; sessionName?: string } = {}): void {
    const input = JSON.stringify({
      tool_name: opts.toolName ?? 'Skill',
      tool_input: { skill: opts.skill ?? 'build' },
    });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      CLAUDE_PROJECT_DIR: projectDir,
      INSTAR_SESSION_NAME: opts.sessionName ?? 'work-session',
    };
    if (opts.sid !== null) env.INSTAR_SESSION_ID = opts.sid ?? SID;
    execFileSync('bash', [SKILL_ENTRY], { input, env, timeout: 10_000 });
  }

  it('writes the per-instance escalated mode-state for a trigger skill', () => {
    runHook({ skill: 'build' });
    const mode = JSON.parse(fs.readFileSync(modeFileOf(projectDir), 'utf8'));
    expect(mode.tier).toBe('escalated');
    expect(mode.trigger).toBe('build');
    expect(mode.instanceId).toBe(SID);
    expect(Number.isFinite(Date.parse(mode.since))).toBe(true);
  });

  it('writes ONLY on transition — a second firing leaves the mode-state untouched (no churn)', () => {
    runHook({ skill: 'build' });
    const first = fs.readFileSync(modeFileOf(projectDir), 'utf8');
    runHook({ skill: 'autonomous' }); // still escalated — not a transition
    const second = fs.readFileSync(modeFileOf(projectDir), 'utf8');
    expect(second).toBe(first); // byte-identical: 'since'/'trigger' NOT rewritten
  });

  it('ignores non-trigger skills', () => {
    runHook({ skill: 'keybindings-help' });
    expect(fs.existsSync(modeFileOf(projectDir))).toBe(false);
  });

  it('is inert when escalation is disabled (fail-closed)', () => {
    writeConfig(projectDir, { enabled: false });
    runHook({ skill: 'build' });
    expect(fs.existsSync(modeFileOf(projectDir))).toBe(false);
  });

  it('is inert without an instance id (fail-closed — never inheritable)', () => {
    runHook({ skill: 'build', sid: null });
    expect(fs.existsSync(stateDirOf(projectDir))).toBe(false);
  });

  it('ignores non-Skill tool events', () => {
    runHook({ toolName: 'Bash' });
    expect(fs.existsSync(modeFileOf(projectDir))).toBe(false);
  });

  it('honors a custom trigger-skill list from config', () => {
    writeConfig(projectDir, { enabled: true, triggers: { skills: ['my-skill'] } });
    runHook({ skill: 'build' }); // no longer a trigger
    expect(fs.existsSync(modeFileOf(projectDir))).toBe(false);
    runHook({ skill: 'my-skill' });
    expect(fs.existsSync(modeFileOf(projectDir))).toBe(true);
  });
});

describe('model-tier-reconciler.js — pure-fs fast path + transition POST', () => {
  let projectDir: string;
  let server: http.Server;
  let serverUrl: string;
  let hits: Array<{ url: string; auth: string | undefined; body: unknown }>;
  let respondWith: () => { status: number; body: unknown };

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tier-reconciler-'));
    writeConfig(projectDir, { enabled: true });
    hits = [];
    respondWith = () => ({ status: 200, body: { status: 'swapped', model: 'claude-fable-5', confirmed: true } });
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        hits.push({ url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
        const r = respondWith();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/model-tier-hooks-behavior.test.ts' });
  });

  // MUST be async (execFile, not execFileSync): the stub HTTP server lives in
  // THIS process — a sync child wait blocks the event loop and the child's
  // fetch can never be answered (it would time out and read as "no hits").
  function runReconciler(envOver: Record<string, string | undefined> = {}): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      CLAUDE_PROJECT_DIR: projectDir,
      INSTAR_SESSION_ID: SID,
      INSTAR_SESSION_NAME: 'work-session',
      INSTAR_SERVER_URL: serverUrl,
      INSTAR_AUTH_TOKEN: 'hook-token',
      ...envOver,
    };
    for (const k of Object.keys(envOver)) {
      if (envOver[k] === undefined) delete env[k];
    }
    return new Promise((resolve, reject) => {
      execFile('node', [RECONCILER], { env, timeout: 10_000 }, err => (err ? reject(err) : resolve()));
    });
  }

  function seedEscalatedMode(sinceMsAgo = 1000): void {
    fs.mkdirSync(stateDirOf(projectDir), { recursive: true });
    fs.writeFileSync(modeFileOf(projectDir), JSON.stringify({
      tier: 'escalated',
      trigger: 'build',
      since: new Date(Date.now() - sinceMsAgo).toISOString(),
      instanceId: SID,
      sessionName: 'work-session',
    }));
  }

  it('FAST PATH: desired == applied (default/default) → zero HTTP, zero writes', async () => {
    await runReconciler();
    expect(hits).toEqual([]);
    expect(fs.existsSync(markerFileOf(projectDir))).toBe(false);
  });

  it('fail-closed: missing env (no auth token) → exits 0, no HTTP', async () => {
    await runReconciler({ INSTAR_AUTH_TOKEN: undefined });
    expect(hits).toEqual([]);
  });

  it('inert when escalation is disabled in config', async () => {
    writeConfig(projectDir, { enabled: false });
    seedEscalatedMode();
    await runReconciler();
    expect(hits).toEqual([]);
  });

  it('TRANSITION: fresh escalated mode-state → ONE authed POST carrying a TIER only', async () => {
    seedEscalatedMode();
    await runReconciler();
    expect(hits.length).toBe(1);
    expect(hits[0].url).toBe('/sessions/work-session/model-swap');
    expect(hits[0].auth).toBe('Bearer hook-token');
    expect(hits[0].body).toEqual({ tier: 'escalated' }); // never a model id
    // Observed 'swapped' → reconciled marker.
    const marker = JSON.parse(fs.readFileSync(markerFileOf(projectDir), 'utf8'));
    expect(marker.tier).toBe('escalated');
  });

  it('reconciles against the OBSERVED outcome — unconfirmed leaves the marker untouched (retry later)', async () => {
    respondWith = () => ({ status: 202, body: { status: 'unconfirmed', confirmed: false } });
    seedEscalatedMode();
    await runReconciler();
    expect(hits.length).toBe(1);
    expect(fs.existsSync(markerFileOf(projectDir))).toBe(false);
    // Next turn retries (still a transition).
    await runReconciler();
    expect(hits.length).toBe(2);
  });

  it('stable refusal (disabled) → cooldown: no re-POST on the next turn', async () => {
    respondWith = () => ({ status: 409, body: { status: 'refused', reason: 'disabled' } });
    seedEscalatedMode();
    await runReconciler();
    expect(hits.length).toBe(1);
    await runReconciler();
    expect(hits.length).toBe(1); // cooldown suppressed the hammer
  });

  it('TTL expiry QUARANTINES the mode-state (fresh trigger required) + audit breadcrumb, no HTTP', async () => {
    writeConfig(projectDir, { enabled: true, costGuards: { maxEscalationTtlMs: 60_000 } });
    seedEscalatedMode(120_000); // older than the 60s TTL
    await runReconciler();
    expect(hits).toEqual([]); // desired degraded to default == applied
    expect(fs.existsSync(modeFileOf(projectDir))).toBe(false);
    expect(fs.existsSync(modeFileOf(projectDir) + '.expired')).toBe(true);
    const audit = fs.readFileSync(path.join(stateDirOf(projectDir), 'audit.jsonl'), 'utf8');
    expect(audit).toContain('ttl-expired');
  });

  it('asymmetric hysteresis: de-escalation waits out dwellTurns before POSTing', async () => {
    writeConfig(projectDir, { enabled: true, costGuards: { minTierDwellTurns: 3, minTierDwellMs: 0 } });
    // Applied = escalated, but the durable signal is gone → desired = default.
    fs.mkdirSync(stateDirOf(projectDir), { recursive: true });
    fs.writeFileSync(markerFileOf(projectDir), JSON.stringify({ tier: 'escalated', at: 0, turnsClear: 0 }));

    await runReconciler(); // turnsClear 1 < 3
    await runReconciler(); // turnsClear 2 < 3
    expect(hits).toEqual([]);
    const counting = JSON.parse(fs.readFileSync(markerFileOf(projectDir), 'utf8'));
    expect(counting.tier).toBe('escalated'); // still applied — only counting
    expect(counting.turnsClear).toBe(2);

    respondWith = () => ({ status: 200, body: { status: 'swapped', confirmed: true } });
    await runReconciler(); // turnsClear 3 ≥ 3 → de-escalation POST
    expect(hits.length).toBe(1);
    expect(hits[0].body).toEqual({ tier: 'default' });
    const marker = JSON.parse(fs.readFileSync(markerFileOf(projectDir), 'utf8'));
    expect(marker.tier).toBe('default');
  });

  it("a predecessor instance's mode-state is never inherited (instance-keyed)", async () => {
    fs.mkdirSync(stateDirOf(projectDir), { recursive: true });
    fs.writeFileSync(modeFileOf(projectDir, 'dead-previous-instance'), JSON.stringify({
      tier: 'escalated', trigger: 'build', since: new Date().toISOString(),
      instanceId: 'dead-previous-instance', sessionName: 'work-session',
    }));
    await runReconciler(); // our SID has no mode-state → desired default → fast path
    expect(hits).toEqual([]);
  });
});
