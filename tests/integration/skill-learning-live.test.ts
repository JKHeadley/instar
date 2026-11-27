// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Skill Learning Sentinel — Tier 2, slice 2 (docs/specs/skill-learning-sentinel.md §3.5 commit protocol,
 * §3.10 pending/confirm routes, §8 "Integration"): the REAL CommitProtocol + VersionStore + LearnedSkillReconciler
 * over a temp agent home, with a fake writer fence that always grants, and the REAL SkillLearningSentinel in
 * live mode over a fixture ledger with stub model families (no network).
 *
 *  - a live write goes through the six-step protocol and the parity rule: canonical temp+rename, renderings in
 *    both layouts carrying `x-instar-stamp`, prepare → commit rows under ONE txId, a version row;
 *  - `pending` stays unrendered (the reconciler's tick too — deviation (dd)) until the operator confirms with
 *    the PIN over the real route: no PIN 403, wrong PIN 403, five tries 429 (the mandate PIN store's limits);
 *  - reject leaves it unrendered and writes a proposal; a bad slug is 400 before anything;
 *  - a hand edit of a rendering locks at the preflight; a hand edit of the canonical locks `operator-owned`;
 *  - forwarding across two express apps: the body (PIN included) reaches the holder unchanged, the holder's
 *    audit row carries `forwardedFromMachine`, a dead holder is 503 `lease-holder-unreachable`, a router URL
 *    resolving to self is handled locally.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { CommitProtocol, fileHashOf } from '../../src/monitoring/skillLearning/CommitProtocol.js';
import { VersionStore } from '../../src/monitoring/skillLearning/VersionStore.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import { skillParityRule } from '../../src/providers/parity/rules/skillParityRule.js';
import {
  createSkillLearningRoutes, SKILL_LEARNING_DISABLED, LEASE_HOLDER_UNREACHABLE, SKILL_LEARNING_PENDING_PIN_MESSAGE, FORWARDED_FROM_HEADER,
} from '../../src/server/skillLearningRoutes.js';
import type { FenceResult } from '../../src/monitoring/skillLearning/WriterFence.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { EventRow, LedgerReader, LedgerRow, LedgerWriter, OutcomeRow, RequestRow, SkillLearningConfig, SkillLearningSentinelLike, VerdictRow } from '../../src/monitoring/skillLearning/types.js';

const TOKEN = 'tok';
const PIN = '246810';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const NAME = 'ci-health-report';
const TMP = process.env.TMPDIR ?? os.tmpdir();

const homes: string[] = [];
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/skill-learning-live.test.ts' });
});

// ── fixtures ──────────────────────────────────────────────────────────────

class FixtureLedger implements LedgerReader, LedgerWriter {
  rows: LedgerRow[] = [];
  append(row: LedgerRow): void { this.rows.push(row); }
  requestsForKey(k: string): RequestRow[] { return this.rows.filter((r): r is RequestRow => r.kind === 'request' && r.procedureKey === k).sort((a, b) => b.at.localeCompare(a.at)); }
  outcomesForKey(k: string): OutcomeRow[] {
    const byRun = new Map<string, OutcomeRow>();
    for (const r of this.rows) if (r.kind === 'outcome' && r.procedureKey === k) { const c = byRun.get(r.runId); if (!c || r.revision > c.revision) byRun.set(r.runId, r); }
    return [...byRun.values()];
  }
  verdictsForKey(k: string): VerdictRow[] {
    const latest = new Map<string, VerdictRow>();
    for (const r of this.rows) if (r.kind === 'verdict' && r.procedureKey === k) { const c = latest.get(r.by); if (!c || r.at >= c.at) latest.set(r.by, r); }
    return [...latest.values()];
  }
  eventsForKey(k: string): EventRow[] { return this.rows.filter((r): r is EventRow => r.kind === 'event' && r.procedureKey === k); }
  keys() {
    const m = new Map<string, { procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }>();
    for (const r of this.rows) {
      if (r.kind !== 'request' || !r.procedureKey) continue;
      const e = m.get(r.procedureKey) ?? { procedureKey: r.procedureKey, requests: 0, verifiedRequests: 0, lastAt: '' };
      e.requests++; if (r.identity === 'verified') e.verifiedRequests++; if (r.at > e.lastAt) e.lastAt = r.at; m.set(r.procedureKey, e);
    }
    return [...m.values()];
  }
  pendingCount(): number { return 0; }
}

/** The drafter's answer for the replay: a learned canonical the lint accepts. */
const SKILL_MD = [
  '---', `name: ${NAME}`,
  'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
  'metadata:', '  short-description: "CI health, weekly"', '---',
  '# CI health report', '', '1. Read the CI health route at /ci/health.', '2. Summarise failing jobs and the slowest runs in plain language.', '',
].join('\n');

/** A learned canonical written straight into the protocol (no sentinel), in a given state. */
function canonicalDoc(state: 'pending' | 'active', body = '# CI health report\n\n1. Read the CI health route at /ci/health.\n'): string {
  return [
    '---', `name: ${NAME}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', '  instar-learned-key: "ci-health"',
    '  instar-learned-version: "1"', '  instar-learned-created: "2026-11-06T11:00:00Z"', '  instar-learned-locked: "false"', `  instar-learned-state: "${state}"`,
    '---', body,
  ].join('\n');
}

/** A fence that always grants `local@0` and counts how often the protocol consulted it. */
function grantingFence() {
  const calls: Array<{ expectedEpoch?: number }> = [];
  return {
    calls,
    acquireFence: (opts: { expectedEpoch?: number } = {}): FenceResult => { calls.push(opts); return { ok: true, epoch: 0, fence: 'local' }; },
    peekEpoch: () => 0,
    medium: () => 'local' as const,
  };
}

interface Home {
  root: string; stateDir: string; machineId: string;
  reconciler: LearnedSkillReconciler; versions: VersionStore; protocol: CommitProtocol; fence: ReturnType<typeof grantingFence>;
  ledger: FixtureLedger; sentinel: SkillLearningSentinel; calls: string[];
}

/**
 * A temp agent home with the real reconciler → version store → commit protocol stack (fake fence), plus the
 * real sentinel in LIVE mode (rung 2 unproven ⇒ every create is `pending`) over a 3/2/2 fixture history with
 * two stub families (so a draft is NOT one-family) and a transcript holding the agent's own tool call.
 */
function home(machineId = 'm1', opts: { mode?: 'live' | 'shadow'; families?: number } = {}): Home {
  const root = fs.mkdtempSync(path.join(TMP, 'sl-live-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'build', 'SKILL.md'), '---\nname: build\ndescription: "Rigorous build process."\n---\nbody\n');
  const reconciler = new LearnedSkillReconciler({ projectDir: root, stateDir, machineId, enabledFrameworks: () => ['claude-code', 'codex-cli'], now: () => NOW });
  const versions = new VersionStore({ stateDir, machineId, now: () => NOW });
  const fence = grantingFence();
  const protocol = new CommitProtocol({ projectDir: root, stateDir, machineId, fence, versions, reconciler, now: () => NOW });
  const ledger = new FixtureLedger();
  const transcripts = new Map<string, string>();
  for (let i = 0; i < 3; i++) {
    const at = NOW - (i + 1) * DAY; const session = `sess-${i}`;
    ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(1180 + i) }, topicId: '42', sessionName: session, at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: 'ci-health', paraphrase: 'weekly CI health', repeatable: true, runId: `run-${i}`, machineId });
    ledger.append({ kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: 'ci-health', topicId: '42', sessionName: session, label: 'accepted', provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 3600_000).toISOString(), at: new Date(at + 3600_000).toISOString(), machineId });
    const file = path.join(root, `${session}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })}\n`);
    transcripts.set(session, file);
  }
  const calls: string[] = [];
  const familyDefs = [{ family: 'anthropic', framework: 'claude-code' }, { family: 'openai', framework: 'codex-cli' }].slice(0, opts.families ?? 2);
  const providers: FamilyProvider[] = familyDefs.map((f) => ({
    family: f.family, framework: f.framework,
    evaluate: async (prompt) => {
      calls.push(f.family);
      if (prompt.startsWith('You are the skill-learning arbiter')) return '{"verdict":"draft","reason":"fixture"}';
      if (prompt.startsWith('You are drafting a reusable skill')) return `NEW\n${SKILL_MD}`;
      if (prompt.startsWith('You are the independent reviewer')) return '{"follows":true,"lines":{},"cost":"accept","reason":"grounded"}';
      throw new Error('unexpected prompt');
    },
  }));
  const mode = opts.mode ?? 'live';
  const config = { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true, mode };
  const sentinel = new SkillLearningSentinel({
    config, stateDir, projectDir: root, machineId, ledger, families: () => providers,
    transcriptPath: (run) => (run.sessionName && transcripts.get(run.sessionName)) ?? null,
    operatorMessage: (src) => `weekly CI health of the instar repo please (msg ${src.messageId})`,
    provenance: { recordDecision: () => 'jp-1', isRecordingLive: () => true },
    commitProtocol: protocol, mode: () => mode, rungTwoProven: () => false,
    now: () => NOW,
  });
  return { root, stateDir, machineId, reconciler, versions, protocol, fence, ledger, sentinel, calls };
}

const renderingOf = (root: string, layout: '.claude' | '.agents', name = NAME) => path.join(root, layout, 'skills', name, 'SKILL.md');
const canonicalOf = (root: string, name = NAME) => path.join(root, '.instar', 'skills', name, 'SKILL.md');
const readIf = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
const STAMP_RE = /^x-instar-stamp:\s*[a-f0-9]{64}\s*$/m;
const journalRows = (h: Home) => fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'journal', `${h.machineId}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const logRows = (h: Home) => { const p = path.join(h.stateDir, 'logs', 'skill-learning.jsonl'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []; };
const treeOf = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
const nothingRendered = (root: string) => expect([readIf(renderingOf(root, '.claude')), readIf(renderingOf(root, '.agents'))]).toEqual([null, null]);

/** The production pipeline in miniature: JSON body, bearer gate, then the module (as the slice-1 routes test builds it). */
function app(opts: { sentinel: SkillLearningSentinelLike | null; enabled?: boolean; holderUrl?: string | null; meshSelfId?: string; port?: number; coordinator?: { holdsLease(): boolean } | null }) {
  const ctx = {
    config: { authToken: TOKEN, dashboardPin: PIN, port: opts.port ?? 4042, monitoring: { skillLearning: { enabled: opts.enabled ?? true } } },
    meshSelfId: opts.meshSelfId ?? 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Studio' : id === 'm_standby' ? 'Laptop' : 'Holder' }) },
    resolveRouterUrl: () => opts.holderUrl ?? null,
    pinAttemptStore: null,
    coordinator: opts.coordinator ?? undefined,
    skillLearningSentinel: () => opts.sentinel,
  } as never;
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return; }
    next();
  });
  a.use(createSkillLearningRoutes(ctx, { forwardTimeoutMs: 2_000 }));
  return a;
}
const auth = { Authorization: `Bearer ${TOKEN}` };

/** Listen on a port so another express app can forward to it; records every request it saw. */
async function serve(a: express.Express): Promise<{ url: string; port: number; calls: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> }> {
  const calls: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  const wrapper = express();
  wrapper.use(express.json());
  wrapper.use((req, _res, next) => { calls.push({ path: req.path, body: req.body, headers: req.headers }); next(); });
  wrapper.use(a);
  const s = http.createServer(wrapper);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, calls };
}

/** The live replay: one tick drafts the fixture key into a `pending` canonical. */
async function replayToPending(h: Home): Promise<void> {
  const s1 = await h.sentinel.tick();
  const s2 = await h.sentinel.tick();
  expect(s1.drafted + s2.drafted).toBe(1);
}

// ── A. the commit protocol + parity, no HTTP ──────────────────────────────

describe('a live write goes through the commit protocol and the parity rule', () => {
  it('create(active): canonical written, both layouts rendered with x-instar-stamp, parity verifies, one txId from prepare to commit, a version row', async () => {
    const h = home();
    const raw = canonicalDoc('active');
    const res = await h.protocol.write('create', NAME, raw, { expectedPrevHash: null, reason: 'test create' });
    expect(res).toMatchObject({ ok: true, version: 1, epoch: 0, fence: 'local', fileHash: fileHashOf(raw) });
    expect(h.fence.calls).toHaveLength(1);
    expect(readIf(canonicalOf(h.root))).toBe(raw);
    for (const layout of ['.claude', '.agents'] as const) {
      const rendered = readIf(renderingOf(h.root, layout));
      expect(rendered, layout).not.toBeNull();
      expect(rendered!, layout).toMatch(STAMP_RE);
      expect(rendered!).toContain('1. Read the CI health route at /ci/health.');
    }
    expect(fs.existsSync(path.join(h.root, '.agents', 'skills', NAME, 'agents', 'openai.yaml'))).toBe(true);
    const verify = await skillParityRule.verify(h.root, NAME);
    expect(verify.ok, JSON.stringify(verify.mismatches)).toBe(true);
    const rows = journalRows(h);
    const txId = (res as { txId: string }).txId;
    expect(rows.filter((r) => r.txId === txId).map((r) => r.op)).toEqual(['commit-prepare', 'commit']);
    expect(rows.find((r) => r.op === 'commit-prepare' && r.txId === txId)).toMatchObject({ name: NAME, commitOp: 'create', expectedPrevHash: null, newHash: fileHashOf(raw), epoch: 0, fence: 'local', machineId: 'm1' });
    // The renders ran as part of the same transaction (the reconciler's rows name the commit).
    expect(rows.filter((r) => r.op === 'render-prepare' && String(r.detail ?? '').includes(`commit:${txId}`)).length).toBe(2); // one per layout
    expect(rows.filter((r) => r.op === 'render-commit')).toHaveLength(2);
    expect(h.versions.rows(NAME)).toHaveLength(1);
    expect(h.versions.lastRow(NAME)).toMatchObject({ version: 1, fileHash: fileHashOf(raw), op: 'create', state: 'active', machineId: 'm1', void: false, superseded: false });
    // The hand-written skill beside it is untouched.
    expect(readIf(path.join(h.root, '.claude', 'skills', 'build', 'SKILL.md'))).toContain('Rigorous build process');
  });

  it('create(pending): the canonical lands but NOTHING is rendered — not by the write, not by a reconcile tick', async () => {
    const h = home();
    const raw = canonicalDoc('pending');
    const res = await h.protocol.write('create', NAME, raw, { expectedPrevHash: null });
    expect(res).toMatchObject({ ok: true, version: 1 });
    expect(readIf(canonicalOf(h.root))).toBe(raw);
    nothingRendered(h.root);
    const tick = await h.reconciler.reconcileAll('tick');
    expect(tick.rendered).toBe(0);
    expect(tick.learned).toBe(0); // a pending canonical is not a render candidate (deviation dd)
    nothingRendered(h.root);
    expect(journalRows(h).map((r) => r.op)).toEqual(['commit-prepare', 'commit']);
  });

  it('a hand edit of the rendering locks at the preflight: the patch is refused, the canonical and the edit both survive, the reconcile never overwrites it', async () => {
    const h = home();
    const v1 = canonicalDoc('active');
    await h.protocol.write('create', NAME, v1, { expectedPrevHash: null });
    const renderedPath = renderingOf(h.root, '.claude');
    const edited = `${fs.readFileSync(renderedPath, 'utf-8')}\n3. My own extra step.\n`;
    fs.writeFileSync(renderedPath, edited);
    const v2 = canonicalDoc('active', '# CI health report\n\n1. Read /ci/health.\n2. New second step.\n');
    const res = await h.protocol.write('patch', NAME, v2, { expectedPrevHash: fileHashOf(v1) });
    expect(res).toMatchObject({ ok: false, reason: 'preflight-conflict' });
    expect((res as { detail: string }).detail).toContain('user-edit-conflict');
    expect(readIf(canonicalOf(h.root))).toBe(v1);
    expect(readIf(renderedPath)).toBe(edited);
    expect(h.versions.rows(NAME)).toHaveLength(1);
    const ops = journalRows(h).filter((r) => r.commitOp === 'patch').map((r) => r.op);
    expect(ops).toEqual(['commit-prepare', 'commit-void']);
    const tick = await h.reconciler.reconcileAll('tick');
    expect(tick.rendered).toBe(0);
    expect(readIf(renderedPath)).toBe(edited);
    const shard = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'rendered-baselines', 'm1.json'), 'utf-8'));
    expect(Object.values(shard.conflicts as Record<string, { reason: string }>).map((c) => c.reason)).toContain('user-edit-conflict');
  });

  it('a hand edit of the canonical locks it operator-owned: the write is refused, the operator’s body is preserved, and it is never rendered again', async () => {
    const h = home();
    const v1 = canonicalDoc('active');
    await h.protocol.write('create', NAME, v1, { expectedPrevHash: null });
    const operatorBody = '# CI health report\n\n1. The operator rewrote this step by hand.\n';
    fs.writeFileSync(canonicalOf(h.root), canonicalDoc('active', operatorBody));
    const res = await h.protocol.write('patch', NAME, canonicalDoc('active', '# CI health report\n\n1. The sentinel’s patch.\n'), { expectedPrevHash: fileHashOf(v1) });
    expect(res).toMatchObject({ ok: false, reason: 'user-edit-conflict' });
    const locked = readIf(canonicalOf(h.root))!;
    expect(locked).toContain(operatorBody.trim());
    expect(locked).toMatch(/instar-learned-state: "?operator-owned"?/);
    expect(locked).toMatch(/instar-learned-locked: "?true"?/);
    expect(locked).not.toContain('The sentinel’s patch');
    const render = await h.reconciler.renderSkill(NAME, 'tx-after-lock');
    expect(render.notRendered).toBe('operator-owned');
    const tick = await h.reconciler.reconcileAll('tick');
    expect(tick.rendered).toBe(0);
    expect(journalRows(h).filter((r) => r.commitOp === 'patch').map((r) => r.op)).toEqual(['commit-prepare', 'commit-void']);
  });

  it('a bad slug is refused by the protocol before anything is journaled', async () => {
    const h = home();
    for (const bad of ['Bad_Name', '-lead', 'a..b', 'x'.repeat(65)]) {
      const res = await h.protocol.write('create', bad, canonicalDoc('active'), { expectedPrevHash: null });
      expect(res, bad).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(fs.existsSync(path.join(h.stateDir, 'skill-learning', 'journal'))).toBe(false);
  });
});

// ── B. pending → confirm / reject over the real route with the real sentinel ──

describe('pending stays unrendered until the operator confirms with the PIN', () => {
  it('the live replay yields exactly one pending canonical, listed by GET /skills/learned, with nothing rendered', async () => {
    const h = home();
    await replayToPending(h);
    const canonical = readIf(canonicalOf(h.root));
    expect(canonical).not.toBeNull();
    expect(canonical!).toMatch(/instar-learned-state: "?pending"?/);
    nothingRendered(h.root);
    expect(fs.existsSync(path.join(h.stateDir, 'skill-learning', 'proposals', NAME))).toBe(false); // live: no shadow proposal
    const status = h.sentinel.status();
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]).toMatchObject({ name: NAME, pendingReason: 'rung-unproven', reviewerFamily: 'openai', version: 1, paraphrases: ['weekly CI health'] });
    expect(status.pending[0].fileHash).toBe(fileHashOf(canonical!));
    expect(status.pending[0].description).toContain('weekly CI health');
    const res = await request(app({ sentinel: h.sentinel })).get('/skills/learned').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('live');
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].name).toBe(NAME);
    // The draft was authored on family A and reviewed ONCE on family B (so it is not one-family); no second draft.
    expect(h.calls.filter((c) => c === 'openai')).toEqual(['openai']);
    expect(h.calls.filter((c) => c === 'anthropic').length).toBeGreaterThanOrEqual(2);
  });

  it('no PIN 403 (the pending message), wrong PIN 403, five wrong tries 429 — and the right PIN is refused too once locked out; nothing rendered', async () => {
    const h = home();
    await replayToPending(h);
    const a = app({ sentinel: h.sentinel });
    expect((await request(a).post(`/skills/learned/pending/${NAME}/confirm`).send({ pin: PIN })).status).toBe(401);
    const noPin = await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({});
    expect(noPin.status).toBe(403);
    expect(noPin.body.error).toBe(SKILL_LEARNING_PENDING_PIN_MESSAGE);
    const wrong = await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: '000000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'Incorrect PIN', attemptsRemaining: 4 });
    for (let i = 0; i < 4; i++) expect((await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: 'nope' })).status).toBe(403);
    const locked = await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(locked.status).toBe(429);
    nothingRendered(h.root);
    expect(readIf(canonicalOf(h.root))!).toMatch(/instar-learned-state: "?pending"?/);
    expect(h.sentinel.status().pending).toHaveLength(1);
  });

  it('the right PIN confirms: the canonical turns active through write(confirm), both layouts render with the stamp, pending empties, a second tap is idempotent', async () => {
    const h = home();
    await replayToPending(h);
    const pendingHash = h.sentinel.status().pending[0].fileHash;
    const a = app({ sentinel: h.sentinel });
    const ok = await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, name: NAME, action: 'confirm', machine: 'Studio' });
    const canonical = readIf(canonicalOf(h.root))!;
    expect(canonical).toMatch(/instar-learned-state: "?active"?/);
    for (const layout of ['.claude', '.agents'] as const) {
      const rendered = readIf(renderingOf(h.root, layout));
      expect(rendered, layout).not.toBeNull();
      expect(rendered!, layout).toMatch(STAMP_RE);
    }
    expect((await skillParityRule.verify(h.root, NAME)).ok).toBe(true);
    const status = h.sentinel.status();
    expect(status.pending).toEqual([]);
    expect(status.skills.map((s) => s.name)).toContain(NAME);
    const confirmRows = journalRows(h).filter((r) => r.commitOp === 'confirm');
    expect(confirmRows.map((r) => r.op)).toEqual(['commit-prepare', 'commit']);
    expect(confirmRows[0]).toMatchObject({ expectedPrevHash: pendingHash });
    expect(h.versions.rows(NAME).map((r) => [r.version, r.op, r.state])).toEqual([[1, 'create', 'pending'], [2, 'confirm', 'active']]);
    expect(logRows(h).filter((r) => r.kind === 'confirm')).toEqual([expect.objectContaining({ name: NAME, prevFileHash: pendingHash, version: 2, forwardedFromMachine: null })]);
    const again = await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(again.status).toBe(200);
    expect(h.versions.rows(NAME)).toHaveLength(2); // nothing re-written
  });

  it('reject leaves it unrendered and writes a proposal (with the operator’s disagree verdict); a reconcile tick still renders nothing', async () => {
    const h = home();
    await replayToPending(h);
    const a = app({ sentinel: h.sentinel });
    const res = await request(a).post(`/skills/learned/pending/${NAME}/reject`).set(auth).send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: NAME, action: 'reject', machine: 'Studio' });
    nothingRendered(h.root);
    const dir = path.join(h.stateDir, 'skill-learning', 'proposals', NAME);
    expect(fs.readdirSync(dir).sort()).toEqual(['SKILL.md', 'proposal.json']);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toMatch(/instar-learned-state: "?proposal"?/);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf-8'));
    expect(sidecar).toMatchObject({ name: NAME, key: 'ci-health', verdict: { by: 'operator', verdict: 'disagree' }, reviewerFamily: 'openai' });
    const status = h.sentinel.status();
    expect(status.pending).toEqual([]);
    expect(status.proposals.map((p) => p.name)).toEqual([NAME]);
    expect(status.skills.map((s) => s.name)).not.toContain(NAME);
    const tick = await h.reconciler.reconcileAll('tick');
    expect(tick.rendered).toBe(0);
    nothingRendered(h.root);
    // The draft path also records the default-rung and arbiter verdicts (slice 1); the operator's tap is the one row this asserts.
    expect(h.ledger.rows.filter((r) => r.kind === 'verdict' && (r as { by?: string }).by === 'operator')).toEqual([expect.objectContaining({ by: 'operator', verdict: 'disagree', procedureKey: 'ci-health' })]);
    expect(logRows(h).filter((r) => r.kind === 'reject')).toHaveLength(1);
  });

  it('a bad slug is 400 before the PIN is looked at; an unknown name is 404; dark is 503', async () => {
    const h = home();
    const a = app({ sentinel: h.sentinel });
    for (const tap of ['confirm', 'reject']) {
      for (const bad of ['Bad_Name', '-lead', 'a..b', 'x'.repeat(65)]) {
        const res = await request(a).post(`/skills/learned/pending/${bad}/${tap}`).set(auth).send({});
        expect(res.status, `${tap} ${bad}`).toBe(400);
        expect(res.body.error).toBe('invalid-skill-name');
      }
      const unknown = await request(a).post(`/skills/learned/pending/never-drafted/${tap}`).set(auth).send({ pin: PIN });
      expect(unknown.status, tap).toBe(404);
      expect(unknown.body.error).toBe('pending-not-found');
    }
    const dark = await request(app({ sentinel: h.sentinel, enabled: false })).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(dark.status).toBe(503);
    expect(dark.body.error).toBe(SKILL_LEARNING_DISABLED);
    expect(fs.existsSync(path.join(h.stateDir, 'skill-learning', 'journal'))).toBe(false);
  });
});

// ── C. forwarding across two express apps ────────────────────────────────

describe('a standby forwards the pending tap to the lease holder', () => {
  it('the body (PIN included) arrives unchanged with X-Instar-Forwarded-From; the holder confirms, its audit row carries forwardedFromMachine; the standby never pre-validates', async () => {
    const holderHome = home('m_holder');
    await replayToPending(holderHome);
    const holder = await serve(app({ sentinel: holderHome.sentinel, meshSelfId: 'm_holder' }));
    const standbyHome = home('m_standby');
    const standby = app({ sentinel: standbyHome.sentinel, meshSelfId: 'm_standby', holderUrl: holder.url });
    // A wrong PIN goes to the holder (the standby does not pre-validate): the holder's 403 comes back as-is.
    const wrong = await request(standby).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: '000000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'Incorrect PIN', attemptsRemaining: 4, handledBy: 'holder-proxy' });
    expect(holder.calls).toHaveLength(1);
    const ok = await request(standby).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, name: NAME, action: 'confirm', machine: 'Holder', forwardedFromMachine: 'm_standby', handledBy: 'holder-proxy' });
    expect(holder.calls).toHaveLength(2);
    expect(holder.calls[1].path).toBe(`/skills/learned/pending/${NAME}/confirm`);
    expect(holder.calls[1].body).toEqual({ pin: PIN });
    expect(holder.calls[1].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(holder.calls[1].headers[FORWARDED_FROM_HEADER]).toBe('m_standby');
    // Rendered on the holder, not on the standby; the holder's audit row names the forwarding machine.
    expect(readIf(renderingOf(holderHome.root, '.claude'))).toMatch(STAMP_RE);
    nothingRendered(standbyHome.root);
    expect(logRows(holderHome).filter((r) => r.kind === 'confirm')).toEqual([expect.objectContaining({ name: NAME, forwardedFromMachine: 'm_standby' })]);
    expect(logRows(standbyHome).filter((r) => r.kind === 'confirm')).toEqual([]);
  });

  it('a dead holder is 503 lease-holder-unreachable and nothing happens locally; so is a coordinator that names no holder while this machine does not hold the lease', async () => {
    const h = home();
    await replayToPending(h);
    const dead = await request(app({ sentinel: h.sentinel, holderUrl: 'http://127.0.0.1:1' })).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(dead.status).toBe(503);
    expect(dead.body.error).toBe(LEASE_HOLDER_UNREACHABLE);
    const noHolder = await request(app({ sentinel: h.sentinel, holderUrl: null, coordinator: { holdsLease: () => false } })).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(noHolder.status).toBe(503);
    expect(noHolder.body.error).toBe(LEASE_HOLDER_UNREACHABLE);
    nothingRendered(h.root);
    expect(readIf(canonicalOf(h.root))!).toMatch(/instar-learned-state: "?pending"?/);
    expect(h.sentinel.status().pending).toHaveLength(1);
    expect(journalRows(h).filter((r) => r.commitOp === 'confirm')).toEqual([]);
  });

  it('a router URL resolving to this machine’s own port is handled locally (no proxy hop); a coordinator that says we hold the lease answers locally too', async () => {
    const h = home();
    await replayToPending(h);
    const self = await request(app({ sentinel: h.sentinel, holderUrl: 'http://localhost:4042', port: 4042, coordinator: { holdsLease: () => true } })).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(self.status).toBe(200);
    expect(self.body).toEqual({ ok: true, name: NAME, action: 'confirm', machine: 'Studio' });
    expect(self.body.handledBy).toBeUndefined();
    expect(readIf(renderingOf(h.root, '.claude'))).toMatch(STAMP_RE);
  });

  it('an already-forwarded request is never bounced again, even when the resolver names another machine', async () => {
    const h = home();
    await replayToPending(h);
    const res = await request(app({ sentinel: h.sentinel, holderUrl: 'http://127.0.0.1:1' })).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).set(FORWARDED_FROM_HEADER, 'm_elsewhere').send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwardedFromMachine: 'm_elsewhere' });
    expect(logRows(h).filter((r) => r.kind === 'confirm')).toEqual([expect.objectContaining({ forwardedFromMachine: 'm_elsewhere' })]);
  });
});

// ── the SafeFs funnel is the one used here ────────────────────────────────
describe('hygiene', () => {
  it('this file cleans up through SafeFsExecutor only (no raw fs.rmSync)', () => {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf-8');
    expect(src).not.toMatch(/\bfs\.rmSync\(/);
    expect(crypto.createHash('sha256').update(src).digest('hex')).toHaveLength(64);
  });
});
