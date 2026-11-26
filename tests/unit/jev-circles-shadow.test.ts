/**
 * jev-circles-shadow — unit tier. Spec: docs/specs/jev-circles-shadow.md.
 *
 * Covers the window builder (the research harness's extract.py format), the
 * transcript-path guard, the check cadence, the would-nudge threshold and the
 * cooldown on both sides, every closed-enum skip reason, the daily cap across a
 * restart, the live kill switch, metering, the summary, and a replay of REAL
 * recorded Jev answer shapes (the research run's jev1.jsonl rows and a live
 * probe response, content-free) — including unsure and order-flipped answers.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JevCirclesShadow,
  buildActions,
  renderWindow,
  isSessionTranscriptPath,
  buildJevCirclesShadow,
  circlesQuestions,
  summarizeCirclesLog,
  CIRCLES_CRITERIA,
  CIRCLES_COOLDOWN_MS,
  WINDOW_HEADER,
  JEV_CIRCLES_FEATURE,
  type JevCirclesShadowConfig,
} from '../../src/core/JevCirclesShadow.js';

const SID = '1ef519d1-7cd6-4294-b4f7-a3eea27cc3b4';
const TRANSCRIPT = `/Users/x/.claude/projects/-Users-x-proj/${SID}.jsonl`;
const OTHER = '0a0b0c0d-1111-4222-8333-444455556666';

// ── Transcript fixtures in Claude Code's JSONL shape ──────────────────

let idn = 0;
function turn(name: string, input: Record<string, unknown>, result: unknown, opts: { note?: string; isError?: boolean } = {}): string[] {
  const id = `toolu_${++idn}`;
  const content: unknown[] = [];
  if (opts.note) content.push({ type: 'text', text: opts.note });
  content.push({ type: 'tool_use', id, name, input });
  return [
    JSON.stringify({ type: 'assistant', message: { content } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(opts.isError ? { is_error: true } : {}) }] } }),
  ];
}

/** A same-fix-same-failure loop: edit, test fails with the same error, repeat. */
function loopTranscript(pairs: number): string {
  const lines: string[] = [];
  for (let i = 0; i < pairs; i++) {
    lines.push(...turn('Edit', { file_path: '/p/src/parser.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated'));
    lines.push(...turn('Bash', { command: 'npm test -- parser' }, 'Exit code 1\nFAIL parser.test.ts > parses dates', { isError: true }));
  }
  return lines.join('\n') + '\n';
}

function jevResponse(stateP: Record<string, number>, stateRevP?: Record<string, number>, model = 'jev-1.13.0') {
  const choice = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
  const ans = (p: Record<string, number>) => ({ type: 'choice', choice: choice(p), confidence: p[choice(p)], probabilities: p });
  return {
    ok: true,
    status: 200,
    json: async () => ({ model, answers: { state: ans(stateP), ...(stateRevP ? { state_rev: ans(stateRevP) } : {}) }, usage: { input_tokens: 1055, output_tokens: 116 } }),
  } as unknown as Response;
}

const CIRCLING = { circling: 0.96, converging: 0.04, polling: 0, normal: 0, cannot_tell: 0 };
const NORMAL = { normal: 0.98, converging: 0.02, circling: 0, polling: 0, cannot_tell: 0 };

function harness(opts: {
  cfg?: JevCirclesShadowConfig;
  key?: string | null;
  transcript?: string;
  fetchImpl?: ReturnType<typeof vi.fn>;
  logPath?: string;
  truncated?: boolean;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-'));
  const logPath = opts.logPath ?? path.join(dir, 'logs', 'jev-circles-shadow.jsonl');
  let nowMs = Date.parse('2026-09-30T12:00:00Z');
  let cfg: JevCirclesShadowConfig = opts.cfg ?? { enabled: true };
  const fetchImpl = opts.fetchImpl ?? vi.fn(async () => jevResponse(NORMAL, NORMAL));
  const metrics = { record: vi.fn() };
  const shadow = new JevCirclesShadow({
    getConfig: () => cfg,
    readKey: () => (opts.key === undefined ? 'k' : opts.key),
    logPath,
    metrics,
    fetchImpl: fetchImpl as never,
    now: () => nowMs,
    readTail: async () => ({ text: opts.transcript ?? loopTranscript(8), truncated: opts.truncated ?? false }),
  });
  const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** Report n actions and wait for any check to settle. */
  const act = async (n: number, sid = SID, tp: unknown = TRANSCRIPT) => {
    for (let i = 0; i < n; i++) {
      shadow.observe({ sessionId: sid, transcriptPath: tp });
      await shadow.lastCheck;
    }
  };
  return {
    shadow, fetchImpl, metrics, rows, act, logPath,
    advance: (ms: number) => { nowMs += ms; },
    setCfg: (c: JevCirclesShadowConfig) => { cfg = c; },
  };
}

// ── Window builder ─────────────────────────────────────────────────────

describe('buildActions / renderWindow — the harness format', () => {
  it('renders each tool the way extract.py does, with notes, flags and tails', () => {
    const jsonl = [
      ...turn('Bash', { command: 'ls   /tmp\n  -la' }, 'total 0', { note: 'Checking the dir.' }),
      ...turn('Bash', { command: 'npm test' }, 'lots of output\nTests: 3 failed'),
      ...turn('Bash', { command: 'false' }, 'Exit code 1', { isError: true }),
      ...turn('Edit', { file_path: '/a/b/parser.ts', old_string: 'x'.repeat(80), new_string: 'y' }, 'updated'),
      ...turn('Write', { file_path: '/a/notes.md', content: 'hi 🤖' }, 'created'),
      ...turn('Read', { file_path: '/a/b/c.ts' }, [{ type: 'text', text: 'file body' }]),
      ...turn('Grep', { pattern: 'foo.*bar' }, 'no matches'),
      ...turn('Skill', { skill: 'instar-dev' }, 'ok'),
      ...turn('TodoWrite', { todos: [] }, 'ok'),
    ].join('\n');
    const acts = buildActions(jsonl);
    expect(acts).toHaveLength(8); // TodoWrite is skipped
    const text = renderWindow(acts);
    expect(text.startsWith(WINDOW_HEADER)).toBe(true);
    const lines = text.slice(WINDOW_HEADER.length).split('\n');
    expect(lines[0]).toBe('1. [Checking the dir.] Bash: ls /tmp -la => ok: total 0');
    expect(lines[1]).toBe('2. Bash: npm test => ERROR: lots of output Tests: 3 failed');
    expect(lines[2]).toBe('3. Bash: false => ERROR: Exit code 1');
    expect(lines[3]).toBe(`4. Edit parser.ts: '${'x'.repeat(50)}' -> 'y' => ok: updated`);
    expect(lines[4]).toBe('5. Write notes.md (4 chars) => ok: created'); // code points, like Python
    expect(lines[5]).toBe('6. Read c.ts => ok: file body');
    expect(lines[6]).toBe('7. Grep: foo.*bar => ok: no matches');
    expect(lines[7]).toBe('8. Skill: {"skill": "instar-dev"} => ok: ok'); // Python json.dumps spacing
  });

  it('skips a torn first line and unmatched results; redacts token shapes', () => {
    const jsonl = '{"type":"user","mess\n' + turn('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwx"' }, 'ok').join('\n')
      + '\n' + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }] } });
    const acts = buildActions(jsonl);
    expect(acts).toHaveLength(1);
    expect(acts[0].head).toContain('[REDACTED');
    expect(acts[0].head).not.toContain('abcdefghijklmnop');
  });
});

describe('secrets are scrubbed before any cut (review round 1)', () => {
  it('a private-key body whose header the tail cut removed is never sent', () => {
    const body = Array.from({ length: 30 }, (_, i) => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC' + String(i).padStart(13, 'x')).join('\n');
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    const acts = buildActions(turn('Bash', { command: 'cat key.pem' }, pem).join('\n'));
    expect(acts[0].tail).toBe('[REDACTED]');
    expect(renderWindow(acts)).not.toContain('MIIEvQIBADAN');
  });
  it('a token across the 160-character command cut is scrubbed before the cut', () => {
    const token = '1234567890:' + 'A'.repeat(35);
    const cmd = 'x'.repeat(140) + ` TG=${token} run`;
    const acts = buildActions(turn('Bash', { command: cmd }, 'ok').join('\n'));
    expect(acts[0].head).not.toMatch(/AAAAAAAAAA/);
  });
  it('a labelled secret whose label falls before the 220-character tail is scrubbed', () => {
    const out = 'password=' + 'Zq7' + 'k'.repeat(40) + ' ' + '.'.repeat(200);
    const acts = buildActions(turn('Bash', { command: 'env' }, out).join('\n'));
    expect(acts[0].tail).not.toContain('kkkkkkkkkk');
  });
});

describe('isSessionTranscriptPath', () => {
  it('accepts only the session\'s own transcript under a Claude config home', () => {
    expect(isSessionTranscriptPath(TRANSCRIPT, SID)).toBe(true);
    expect(isSessionTranscriptPath(`/Users/x/.claude-followme-a/projects/-p/${SID}.jsonl`, SID)).toBe(true);
    expect(isSessionTranscriptPath('/Users/x/work/projects/notes2026.jsonl', 'notes2026')).toBe(false); // not a UUID
    expect(isSessionTranscriptPath(`/Users/x/work/projects/-p/${SID}.jsonl`, SID)).toBe(false); // not under .claude*
    expect(isSessionTranscriptPath(`/Users/x/.claude/projects/${SID}.jsonl`, SID)).toBe(false); // wrong depth
    expect(isSessionTranscriptPath(`/Users/x/.claude/projects/p/other.jsonl`, SID)).toBe(false);
    expect(isSessionTranscriptPath(`/etc/${SID}.jsonl`, SID)).toBe(false);
    expect(isSessionTranscriptPath(`relative/projects/${SID}.jsonl`, SID)).toBe(false);
    expect(isSessionTranscriptPath(`/a/projects/../../etc/${SID}.jsonl`, SID)).toBe(false);
    expect(isSessionTranscriptPath('', SID)).toBe(false);
    expect(isSessionTranscriptPath(TRANSCRIPT, '../x')).toBe(false);
  });
});

// ── The shadow ─────────────────────────────────────────────────────────

describe('JevCirclesShadow — cadence and the request', () => {
  it('checks every 5th action, sends the measured question pinned to jev-1.13.0, scrubbed', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(...turn('Bash', { command: `echo ${i}` }, i === 15 ? `token ${secret}` : 'ok'));
    const h = harness({ transcript: lines.join('\n') });
    await h.act(4);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await h.act(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.questions).toEqual(circlesQuestions());
    expect(body.questions.state.criteria).toEqual(CIRCLES_CRITERIA);
    expect(Object.keys(body.questions.state_rev.criteria)).toEqual(Object.keys(CIRCLES_CRITERIA).reverse());
    expect(body.state.startsWith(WINDOW_HEADER)).toBe(true);
    expect(body.state.split('\n')).toHaveLength(16); // header + 15 actions
    expect(body.state).not.toContain(secret);
    await h.act(5);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks nothing until the session has 15 actions', async () => {
    const h = harness({ transcript: loopTranscript(7) }); // 14 actions
    await h.act(10);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.rows()).toEqual([]);
  });

  it('is inert when disabled, and the kill switch is read live', async () => {
    const off = harness({ cfg: { enabled: false } });
    await off.act(10);
    expect(off.fetchImpl).not.toHaveBeenCalled();

    const h = harness();
    await h.act(5);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.setCfg({ enabled: false });
    await h.act(10);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('meters every call into feature metrics', async () => {
    const h = harness();
    await h.act(5);
    expect(h.metrics.record).toHaveBeenCalledWith(expect.objectContaining({ feature: JEV_CIRCLES_FEATURE, kind: 'llm', tokensIn: 1055, model: 'jev-1.13.0', framework: 'typesafe-api' }));
  });
});

describe('JevCirclesShadow — would-nudge and cooldown', () => {
  it('P(circling) at the threshold would nudge; just below would not', async () => {
    const at = harness({ fetchImpl: vi.fn(async () => jevResponse({ circling: 0.5, converging: 0.5, polling: 0, normal: 0, cannot_tell: 0 })) });
    await at.act(5);
    expect(at.rows()[0]).toMatchObject({ kind: 'check', wouldNudge: true, pCircling: 0.5 });
    const below = harness({ fetchImpl: vi.fn(async () => jevResponse({ circling: 0.49, converging: 0.51, polling: 0, normal: 0, cannot_tell: 0 })) });
    await below.act(5);
    expect(below.rows()[0]).toMatchObject({ kind: 'check', label: 'converging', wouldNudge: false, pCircling: 0.49 });
    expect(below.rows()[0].cooldown).toBeUndefined();
  });

  it('holds a second would-nudge inside 30 minutes per session, and fires again after', async () => {
    const h = harness({ fetchImpl: vi.fn(async () => jevResponse(CIRCLING, CIRCLING)) });
    await h.act(5);
    h.advance(CIRCLES_COOLDOWN_MS - 1);
    await h.act(5);
    await h.act(5, OTHER, `/h/.claude/projects/p/${OTHER}.jsonl`); // cooldown is per session
    h.advance(1);
    await h.act(5);
    const checks = h.rows().filter((r) => r.kind === 'check');
    expect(checks.map((r) => [r.session === SID, r.wouldNudge, r.cooldown ?? false])).toEqual([
      [true, true, false],
      [true, false, true],
      [false, true, false],
      [true, true, false],
    ]);
    expect(checks[0]).toMatchObject({ label: 'circling', confidence: 0.96, labelRev: 'circling', pCirclingRev: 0.96, errorActions: 8 });
  });

  it('rows carry no window content', async () => {
    const h = harness({ fetchImpl: vi.fn(async () => jevResponse(CIRCLING, CIRCLING)) });
    await h.act(5);
    const raw = fs.readFileSync(h.logPath, 'utf8');
    expect(raw).not.toContain('parser');
    expect(raw).not.toContain('npm test');
    expect(Object.keys(h.rows()[0]).sort()).toEqual(['confidence', 'errorActions', 'kind', 'label', 'labelRev', 'ms', 'pCircling', 'pCirclingRev', 'session', 'ts', 'wouldNudge']);
  });
});

describe('JevCirclesShadow — failures are closed-enum rows, never throws', () => {
  it('no key: one disabled-no-key row per session, no call', async () => {
    const h = harness({ key: null });
    await h.act(15);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.rows()).toEqual([expect.objectContaining({ kind: 'skipped', reason: 'disabled-no-key' })]);
  });

  it('a foreign transcript path is never read: one no-transcript row per session', async () => {
    const readTail = vi.fn();
    const h = harness();
    (h.shadow as unknown as { deps: { readTail: unknown } }).deps.readTail = readTail;
    await h.act(10, SID, '/etc/passwd');
    expect(readTail).not.toHaveBeenCalled();
    expect(h.rows()).toEqual([expect.objectContaining({ reason: 'no-transcript' })]);
  });

  it.each([
    ['http-error', async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response],
    ['model-mismatch', async () => jevResponse(CIRCLING, CIRCLING, 'jev-latest')],
    ['no-answers', async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: {} }) }) as unknown as Response],
    ['timeout', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
    ['http-error', async () => { throw new Error('ECONNRESET'); }],
  ])('%s', async (reason, impl) => {
    const h = harness({ fetchImpl: vi.fn(impl) });
    await h.act(5);
    expect(h.rows()).toEqual([expect.objectContaining({ kind: 'skipped', reason })]);
    expect(h.metrics.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('a truncated tail holding fewer than 15 actions records short-window once per session', async () => {
    const h = harness({ transcript: loopTranscript(3), truncated: true });
    await h.act(15);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.rows()).toEqual([expect.objectContaining({ reason: 'short-window' })]);
    const early = harness({ transcript: loopTranscript(3) }); // just early in the session: no row
    await early.act(15);
    expect(early.rows()).toEqual([]);
  });

  it('the real reader refuses a transcript path that symlinks elsewhere', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-ln-'));
    const outside = path.join(root, 'outside.jsonl');
    fs.writeFileSync(outside, loopTranscript(8));
    const dir = path.join(root, '.claude', 'projects', '-p');
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, `${SID}.jsonl`);
    fs.symlinkSync(outside, link);
    const fetchImpl = vi.fn(async () => jevResponse(NORMAL));
    const logPath = path.join(root, 'log.jsonl');
    const s = new JevCirclesShadow({ getConfig: () => ({ enabled: true }), readKey: () => 'k', logPath, fetchImpl: fetchImpl as never });
    for (let i = 0; i < 5; i++) { s.observe({ sessionId: SID, transcriptPath: link }); await s.lastCheck; }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"no-transcript"');
    // A real file in the same place is read.
    const real = path.join(fs.realpathSync(dir), `${OTHER}.jsonl`);
    fs.writeFileSync(real, loopTranscript(8));
    for (let i = 0; i < 5; i++) { s.observe({ sessionId: OTHER, transcriptPath: real }); await s.lastCheck; }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a real fetch timeout aborts within the bound', async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => {
      init.signal!.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    }));
    const h = harness({ cfg: { enabled: true, timeoutMs: 20 }, fetchImpl });
    await h.act(5);
    expect(h.rows()[0]).toMatchObject({ reason: 'timeout' });
  });
});

describe('JevCirclesShadow — the daily cap', () => {
  it('stops calling at the cap with one daily-cap row, and the count survives a restart', async () => {
    const h = harness({ cfg: { enabled: true, maxChecksPerDay: 2 } });
    await h.act(20);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.rows().filter((r) => r.reason === 'daily-cap')).toHaveLength(1);

    // A restart: a fresh instance on the same log does not reset today's count.
    const again = harness({ cfg: { enabled: true, maxChecksPerDay: 2 }, logPath: h.logPath });
    await again.act(10);
    expect(again.fetchImpl).not.toHaveBeenCalled();
  });

  it('a new UTC day starts a new count', async () => {
    const h = harness({ cfg: { enabled: true, maxChecksPerDay: 1 } });
    await h.act(10);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    h.advance(24 * 3600_000);
    await h.act(5);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ── Replay of REAL recorded Jev answer shapes ───────────────────────────

/**
 * Content-free rows from the research run (scratchpad circles/jev1.jsonl,
 * 2026-09-30, jev-1.13.0): window id + both orders' probabilities. Chosen to
 * cover confident circling, the 0.5 boundary, unsure answers, polling, and
 * forward/reverse flips.
 */
const RECORDED = [
  { id: '73c08c06d3', state: 'circling', stateP: { converging: 0.04, circling: 0.96, polling: 0, normal: 0, cannot_tell: 0 }, stateRev: 'circling', stateRevP: { circling: 0.98, converging: 0.02, polling: 0, normal: 0, cannot_tell: 0 } },
  { id: '63407910c2', state: 'circling', stateP: { polling: 0, converging: 0.48, normal: 0.02, cannot_tell: 0, circling: 0.5 }, stateRev: 'circling', stateRevP: { polling: 0, normal: 0.01, converging: 0.29, cannot_tell: 0, circling: 0.7 } },
  { id: 'd996c04928', state: 'circling', stateP: { cannot_tell: 0, normal: 0, circling: 0.6900000000000001, converging: 0.3, polling: 0.01 }, stateRev: 'circling', stateRevP: { cannot_tell: 0, circling: 0.76, normal: 0, converging: 0.24, polling: 0 } },
  { id: '52ba6e6880', state: 'converging', stateP: { cannot_tell: 0, normal: 0.01, circling: 0.37, converging: 0.6, polling: 0.02 }, stateRev: 'circling', stateRevP: { cannot_tell: 0, circling: 0.51, normal: 0.01, converging: 0.47, polling: 0.01 } },
  { id: 'fc43bbaa2e', state: 'converging', stateP: { converging: 0.44, polling: 0.09, normal: 0.04, cannot_tell: 0.01, circling: 0.42 }, stateRev: 'circling', stateRevP: { converging: 0.41, polling: 0.1, cannot_tell: 0.01, normal: 0.03, circling: 0.45 } },
  { id: 'e0ff0e635a', state: 'normal', stateP: { normal: 0.54, polling: 0, cannot_tell: 0.02, circling: 0, converging: 0.44 }, stateRev: 'converging', stateRevP: { normal: 0.47, polling: 0, cannot_tell: 0, circling: 0, converging: 0.53 } },
  { id: 'dfc69c3310', state: 'converging', stateP: { normal: 0.29, converging: 0.41, circling: 0, cannot_tell: 0, polling: 0.3 }, stateRev: 'polling', stateRevP: { circling: 0, converging: 0.34, normal: 0.2, cannot_tell: 0, polling: 0.46 } },
  { id: 'ef3d05114e', state: 'polling', stateP: { circling: 0, converging: 0.28, cannot_tell: 0, normal: 0.22, polling: 0.5 }, stateRev: 'polling', stateRevP: { normal: 0.12, converging: 0.27, circling: 0, cannot_tell: 0, polling: 0.61 } },
  { id: 'b2c3ecc18f', state: 'circling', stateP: { cannot_tell: 0, circling: 0.51, converging: 0.32, polling: 0.16, normal: 0.01 }, stateRev: 'circling', stateRevP: { normal: 0.01, circling: 0.61, converging: 0.3, polling: 0.08, cannot_tell: 0 } },
];

describe('replay: recorded Jev answer shapes', () => {
  it.each(RECORDED)('$id → label $state, would-nudge iff forward P(circling) ≥ 0.5', async (r) => {
    const ans = (choice: string, p: Record<string, number>) => ({ type: 'choice', choice, confidence: p[choice], probabilities: p });
    const h = harness({
      fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { state: ans(r.state, r.stateP), state_rev: ans(r.stateRev, r.stateRevP) }, usage: { input_tokens: 2400 } }) }) as unknown as Response),
    });
    await h.act(5);
    const row = h.rows()[0];
    expect(row).toMatchObject({
      kind: 'check',
      label: r.state,
      confidence: (r.stateP as Record<string, number>)[r.state],
      pCircling: r.stateP.circling,
      labelRev: r.stateRev,
      pCirclingRev: r.stateRevP.circling,
      wouldNudge: r.stateP.circling >= 0.5,
    });
  });

  it('the live probe response shape (2026-09-30, extra usage.output_tokens and confidence fields) parses', async () => {
    const live = { model: 'jev-1.13.0', answers: { state: { type: 'choice', choice: 'circling', confidence: 1, probabilities: { circling: 1, polling: 0, converging: 0, normal: 0, cannot_tell: 0 } }, state_rev: { type: 'choice', choice: 'circling', confidence: 1, probabilities: { normal: 0, polling: 0, converging: 0, circling: 1, cannot_tell: 0 } } }, usage: { input_tokens: 1055, output_tokens: 116 } };
    const h = harness({ fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => live }) as unknown as Response) });
    await h.act(5);
    expect(h.rows()[0]).toMatchObject({ label: 'circling', confidence: 1, pCircling: 1, wouldNudge: true });
  });
});

// ── Summary and wiring ─────────────────────────────────────────────────

describe('summary', () => {
  it('tallies checks, would-nudges, cooldown holds, labels, skips and per-session counts', async () => {
    const h = harness({ fetchImpl: vi.fn(async () => jevResponse(CIRCLING, CIRCLING)) });
    await h.act(10);
    fs.appendFileSync(h.logPath, 'torn{\n' + JSON.stringify({ kind: 'skipped', ts: '2026-09-30T12:00:00.000Z', session: SID, reason: 'busy' }) + '\n');
    const s = h.shadow.summary();
    expect(s).toMatchObject({ enabled: true, checks: 2, wouldNudges: 1, cooldownHeld: 1, labels: { circling: 2 }, skipped: { busy: 1 } });
    expect(s.perSession[SID]).toMatchObject({ checks: 2, wouldNudges: 1 });
    expect(summarizeCirclesLog('/nonexistent/x.jsonl', false)).toMatchObject({ enabled: false, checks: 0, since: null });
  });
});

describe('buildJevCirclesShadow — the dev gate, read live', () => {
  function build(developmentAgent: boolean, live: unknown, boot?: JevCirclesShadowConfig) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-b-'));
    let intel = live;
    const s = buildJevCirclesShadow({ readLiveIntelligence: () => intel, bootBlock: boot, developmentAgent, readSecret: () => 'k', stateDir: path.join(dir, '.instar') });
    const cfg = () => (s as unknown as { deps: { getConfig: () => JevCirclesShadowConfig } }).deps.getConfig();
    return { s, cfg, set: (v: unknown) => { intel = v; }, dir };
  }
  it('omitted enabled: live on a development agent, dark on the fleet', () => {
    expect(build(true, { jevCirclesShadow: { timeoutMs: 1500 } }).cfg().enabled).toBe(true);
    expect(build(false, { jevCirclesShadow: { timeoutMs: 1500 } }).cfg().enabled).toBe(false);
  });
  it('explicit false is the kill switch on a dev agent, read live; boot block is the fallback', () => {
    const b = build(true, undefined, { maxChecksPerDay: 7 });
    expect(b.cfg()).toMatchObject({ enabled: true, maxChecksPerDay: 7 });
    b.set({ jevCirclesShadow: { enabled: false } });
    expect(b.cfg().enabled).toBe(false);
  });
  it('logs under the agent logs dir', () => {
    const b = build(true, undefined);
    expect((b.s as unknown as { deps: { logPath: string } }).deps.logPath).toBe(path.join(b.dir, 'logs', 'jev-circles-shadow.jsonl'));
  });
});
