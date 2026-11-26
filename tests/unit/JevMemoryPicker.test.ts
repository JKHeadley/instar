// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * JevMemoryPicker — ranks the Claude Code memory index at session start.
 * Spec: docs/specs/jev-memory-picker.md
 *
 * No network: every test injects a fetch stub. Both sides of every decision:
 * the positional cut, pinned vs ranked, ranked vs every fallback reason, the
 * path derivation's accept and refuse cases, and the row's no-text contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JevMemoryPicker, parseIndex, compose, candidates, rankByScore, memoryIndexPath, resolveMemoryIndexPath,
  renderInjectBlock, topicOpeningContext, pickSource, buildJevMemoryPicker,
  PINNED_MARKER, POSITIONAL_MAX_CHARS, POSITIONAL_MAX_LINES, JEV_MEMORY_PICKER_FEATURE, INJECT_HEADER, KEY_REREAD_MS,
  type JevMemoryPickerConfig,
} from '../../src/core/JevMemoryPicker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const SECRET_TOPIC = 'a very specific opening sentence that must never appear in the log';

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mem-'));
  logPath = path.join(dir, 'logs', 'jev-memory-picker.jsonl');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'jev-memory-picker-unit.cleanup' });
});
const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** An index of `n` entries, each ~`width` chars, so the cut falls where we choose. */
function makeIndex(n: number, width = 200, mark: (i: number) => string = () => ''): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const head = `- [Memory ${i}](m${i}.md) — note number ${i}${mark(i)}`;
    lines.push(head + ' '.repeat(Math.max(0, width - head.length)).replace(/ /g, 'x'));
  }
  return lines.join('\n') + '\n';
}
function writeIndex(content: string): string {
  const p = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(p, content);
  return p;
}

function okResponse(answers: Record<string, number>, model = 'jev-1.13.0') {
  return {
    ok: true, status: 200,
    json: async () => ({ model, usage: { input_tokens: 999 }, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { noul: v }])) }),
  } as unknown as Response;
}

function makePicker(opts: { cfg?: JevMemoryPickerConfig; key?: string | null; fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; metrics?: Array<Record<string, unknown>>; now?: () => number } = {}) {
  const calls: Array<{ url: string; body: { state: string; model: string; questions: Record<string, { instructions: string }> } }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return (opts.fetchImpl ?? (async () => okResponse({})))(url, init);
  };
  const picker = new JevMemoryPicker({
    getConfig: () => ({ enabled: true, ...(opts.cfg ?? {}) }),
    readKey: () => (opts.key === undefined ? 'test-key' : opts.key),
    logPath,
    metrics: opts.metrics ? { record: (r) => opts.metrics!.push(r) } : null,
    fetchImpl: fetchImpl as never,
    now: opts.now ?? (() => NOW),
  });
  return { picker, calls };
}

describe('parseIndex — the positional cut', () => {
  it('marks entries inside the first 25,000 characters as loaded, the rest as beyond the cut', () => {
    const entries = parseIndex(makeIndex(200, 200));
    // Each line is 200 chars + a newline: 124 lines fit (124*201-1 = 24,923), the 125th passes 25,000.
    expect(entries.filter((e) => e.inPrefix).length).toBe(124);
    expect(entries[123].inPrefix).toBe(true);
    expect(entries[124].inPrefix).toBe(false);
    expect(POSITIONAL_MAX_CHARS).toBe(25_000);
  });

  it('caps the prefix at 200 lines even when the characters would fit', () => {
    const entries = parseIndex(makeIndex(260, 20));
    expect(entries.filter((e) => e.inPrefix).length).toBe(POSITIONAL_MAX_LINES);
    expect(entries[199].inPrefix).toBe(true);
    expect(entries[200].inPrefix).toBe(false);
  });

  it('matches the measured cut on a real-shaped index (line 117 in, line 118 out)', () => {
    // Echo's index on 2026-09-30: lines 1–117 = 24,898 chars, 118 lines = 25,087.
    const lines = Array.from({ length: 287 }, (_, i) => `- [Entry ${i + 1}](e.md) — ` + 'y'.repeat(i < 116 ? 199 : 180));
    const content = lines.join('\n');
    const upTo = (n: number) => lines.slice(0, n).join('\n').length;
    const entries = parseIndex(content);
    const last = entries.filter((e) => e.inPrefix).length;
    expect(upTo(last)).toBeLessThanOrEqual(25_000);
    expect(upTo(last + 1)).toBeGreaterThan(25_000);
  });

  it('treats only "- " lines as entries, and strips the pinned marker', () => {
    const entries = parseIndex(`# heading\n\n- [A](a.md) — a\n- [B](b.md) — b ${PINNED_MARKER}\nnot an entry\n`);
    expect(entries.map((e) => e.line)).toEqual([3, 4]);
    expect(entries[1].pinned).toBe(true);
    expect(entries[1].text).toBe('- [B](b.md) — b');
    expect(entries[0].pinned).toBe(false);
    expect(entries[0].id).toMatch(/^L3-[0-9a-f]{8}$/);
  });
});

describe('compose + rankByScore', () => {
  const entries = parseIndex(makeIndex(150, 200, (i) => (i === 140 || i === 10 ? ` ${PINNED_MARKER}` : '')));
  const cands = candidates(entries);

  it('ranks only non-pinned entries beyond the cut', () => {
    expect(cands.every((e) => !e.inPrefix && !e.pinned)).toBe(true);
    expect(cands.some((e) => e.line === 140)).toBe(false);
    expect(cands.length).toBe(150 - 124 - 1);
  });

  it('adds pinned-beyond-cut first, then the highest scores, ties by position', () => {
    const scores = new Map<number, number>([[130, 0.2], [131, 0.9], [132, 0.2], [133, 0.5]]);
    const ranked = rankByScore(cands, scores);
    expect(ranked.map((e) => e.line)).toEqual([131, 133, 130, 132]);
    const inject = compose(entries, ranked, 3, 100_000);
    expect(inject.map((e) => e.line)).toEqual([140, 131, 133]); // line 10 is pinned but already loads
  });

  it('stops at the character cap', () => {
    const ranked = rankByScore(cands, new Map(cands.map((e, i) => [e.line, 1 - i / 100])));
    const inject = compose(entries, ranked, 40, 3 * 201);
    expect(inject.length).toBe(3);
  });

  it('with no ranking adds only the pinned entries beyond the cut', () => {
    expect(compose(entries, [], 40, 10_000).map((e) => e.line)).toEqual([140]);
    const unpinned = parseIndex(makeIndex(150, 200));
    expect(compose(unpinned, [], 40, 10_000)).toEqual([]);
  });
});

describe('memoryIndexPath / resolveMemoryIndexPath', () => {
  const home = '/Users/me';
  it('derives Claude Code\'s project key', () => {
    expect(memoryIndexPath('/Users/me/.claude', '/Users/me/.instar/agents/echo', home))
      .toBe('/Users/me/.claude/projects/-Users-me--instar-agents-echo/memory/MEMORY.md');
    expect(memoryIndexPath('/Users/me/.claude-followme-x', '/p', home)).toBe('/Users/me/.claude-followme-x/projects/-p/memory/MEMORY.md');
  });
  it('refuses a config dir outside home, not named .claude*, relative, or traversing', () => {
    expect(memoryIndexPath('/tmp/.claude', '/p', home)).toBeNull();
    expect(memoryIndexPath('/Users/me/../../tmp/.claude', '/p', home)).toBeNull();
    expect(memoryIndexPath('/Users/me/.ssh', '/p', home)).toBeNull();
    expect(memoryIndexPath('.claude', '/p', home)).toBeNull();
    expect(memoryIndexPath('/Users/me/.claude', 'rel', home)).toBeNull();
    expect(memoryIndexPath(42, '/p', home)).toBeNull();
  });
  it('a projectDir cannot inject a separator into the key', () => {
    expect(memoryIndexPath('/Users/me/.claude', '/a/../../../etc', home)).toBe('/Users/me/.claude/projects/-etc/memory/MEMORY.md');
  });

  it('resolves a real index, and refuses a symlinked index or a config dir linked out of home', async () => {
    const home2 = fs.realpathSync(dir);
    const cfg = path.join(home2, '.claude');
    const memDir = path.join(cfg, 'projects', '-proj', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [A](a.md) — a\n');
    expect(await resolveMemoryIndexPath(cfg, '/proj', home2)).toBe(path.join(memDir, 'MEMORY.md'));
    expect(await resolveMemoryIndexPath(cfg, '/absent', home2)).toBeNull();

    const secret = path.join(home2, 'secret.txt');
    fs.writeFileSync(secret, '- token\n');
    const linkMem = path.join(cfg, 'projects', '-linked', 'memory');
    fs.mkdirSync(linkMem, { recursive: true });
    fs.symlinkSync(secret, path.join(linkMem, 'MEMORY.md'));
    expect(await resolveMemoryIndexPath(cfg, '/linked', home2)).toBeNull();

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mem-out-'));
    try {
      fs.symlinkSync(outside, path.join(home2, '.claude-out'));
      expect(await resolveMemoryIndexPath(path.join(home2, '.claude-out'), '/proj', home2)).toBeNull();
    } finally {
      SafeFsExecutor.safeRmSync(outside, { recursive: true, force: true, operation: 'jev-memory-picker-unit.cleanup' });
    }
  });
});

describe('JevMemoryPicker.pick', () => {
  it('ranks beyond-cut entries with two questions each, averages them, and logs ids only', async () => {
    const metrics: Array<Record<string, unknown>> = [];
    const { picker, calls } = makePicker({
      metrics,
      fetchImpl: async () => okResponse({ b130: 0.9, c130: 0.7, b131: 0.1, c131: 0.1, b140: 0.6 }),
    });
    const p = writeIndex(makeIndex(150, 200));
    const res = await picker.pick(p, `Topic: Jev\nUser: ${SECRET_TOPIC}`, 'startup');
    await picker.flush();
    expect(res.outcome).toBe('ranked');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].body.model).toBe('jev-1.13.0');
    const keys = Object.keys(calls[0].body.questions);
    expect(keys.length).toBe(2 * (150 - 124));
    expect(keys).not.toContain('b1'); // loaded entries are never asked about
    expect(calls[0].body.questions.b130.instructions).toContain('Memory 130');
    expect(calls[0].body.questions.c130.instructions).toContain('general working principle');
    // 130: mean 0.8; 140: only b answered → 0.6; 131: 0.1. Unscored entries are not added.
    expect(res.inject.map((e) => e.line)).toEqual([130, 140, 131]);
    expect(res.scores.get(130)).toBeCloseTo(0.8);
    const [row] = rows();
    expect(row).toMatchObject({ outcome: 'ranked', source: 'startup', mode: 'shadow', entries: 150, prefix: 124, candidates: 26, model: 'jev-1.13.0' });
    expect(row.inject[0]).toEqual({ id: res.inject[0].id, p: 0.8 });
    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw).not.toContain(SECRET_TOPIC);
    expect(raw).not.toContain('Memory 130');
    expect(metrics).toEqual([expect.objectContaining({ feature: JEV_MEMORY_PICKER_FEATURE, kind: 'llm', outcome: 'fired', framework: 'typesafe-api', tokensIn: 999 })]);
  });

  it('skips without a call when the whole index fits', async () => {
    const { picker, calls } = makePicker();
    const res = await picker.pick(writeIndex(makeIndex(50, 100)), 'Topic: x');
    await picker.flush();
    expect(res).toMatchObject({ outcome: 'skipped', reason: 'fits', inject: [] });
    expect(calls).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ outcome: 'skipped', reason: 'fits' });
  });

  it('skips on no context and on a missing index', async () => {
    const { picker, calls } = makePicker();
    expect((await picker.pick(writeIndex(makeIndex(150, 200)), '   ')).reason).toBe('no-context');
    expect((await picker.pick(path.join(dir, 'nope.md'), 'Topic: x')).reason).toBe('no-index');
    expect(calls).toHaveLength(0);
  });

  it('a pinned line past the cut is added even when skipping, and never sent to Jev', async () => {
    const { picker, calls } = makePicker({ fetchImpl: async () => okResponse({ b130: 0.5 }) });
    const p = writeIndex(makeIndex(150, 200, (i) => (i === 145 ? ` ${PINNED_MARKER}` : '')));
    const skipped = await picker.pick(p, '');
    expect(skipped.inject.map((e) => e.line)).toEqual([145]);
    const ranked = await picker.pick(p, 'Topic: x');
    expect(ranked.inject.map((e) => e.line)).toEqual([145, 130]);
    expect(Object.keys(calls[0].body.questions)).not.toContain('b145');
  });

  const fallbacks: Array<[string, Parameters<typeof makePicker>[0]]> = [
    ['disabled-no-key', { key: null }],
    ['http-error', { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'echo of input' }) }) as unknown as Response }],
    ['model-mismatch', { fetchImpl: async () => okResponse({ b130: 0.9 }, 'jev-latest') }],
    ['no-answers', { fetchImpl: async () => okResponse({}) }],
    ['http-error', { fetchImpl: async () => { throw new Error('ECONNRESET'); } }],
  ];
  for (const [reason, opts] of fallbacks) {
    it(`falls back to today's load on ${reason} (${opts?.key === null ? 'no key' : 'vendor'})`, async () => {
      const { picker } = makePicker(opts);
      const res = await picker.pick(writeIndex(makeIndex(150, 200)), 'Topic: x');
      await picker.flush();
      expect(res).toMatchObject({ outcome: 'fallback', reason, inject: [] });
      expect(rows()[0]).toMatchObject({ outcome: 'fallback', reason });
      expect(fs.readFileSync(logPath, 'utf8')).not.toContain('echo of input');
    });
  }

  it('times out within timeoutMs + slack against a fetch that never settles', async () => {
    const { picker } = makePicker({ cfg: { timeoutMs: 100 }, fetchImpl: () => new Promise<Response>(() => {}), now: Date.now });
    const t0 = Date.now();
    const res = await picker.pick(writeIndex(makeIndex(150, 200)), 'Topic: x');
    expect(res).toMatchObject({ outcome: 'fallback', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('an aborting fetch is recorded as a timeout', async () => {
    const { picker } = makePicker({
      cfg: { timeoutMs: 100 },
      now: Date.now,
      fetchImpl: (_u, init) => new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    expect((await picker.pick(writeIndex(makeIndex(150, 200)), 'Topic: x')).reason).toBe('timeout');
  });

  it('enforces the daily call cap and the in-flight bound', async () => {
    const { picker, calls } = makePicker({ cfg: { dailyCallCap: 1 }, fetchImpl: async () => okResponse({ b130: 0.5 }) });
    const p = writeIndex(makeIndex(150, 200));
    expect((await picker.pick(p, 'Topic: x')).outcome).toBe('ranked');
    expect((await picker.pick(p, 'Topic: x')).reason).toBe('daily-cap');
    expect(calls).toHaveLength(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { picker: busy } = makePicker({ fetchImpl: async () => { await gate; return okResponse({ b130: 0.5 }); } });
    const a = busy.pick(p, 'Topic: x');
    const b = busy.pick(p, 'Topic: x');
    await new Promise((r) => setTimeout(r, 20));
    expect((await busy.pick(p, 'Topic: x')).reason).toBe('busy');
    release();
    expect((await a).outcome).toBe('ranked');
    expect((await b).outcome).toBe('ranked');
  });

  it('scrubs secrets from the context, glossary and entry lines before egress', async () => {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { picker, calls } = makePicker({ cfg: { glossary: ['Sol = a Codex model', `key ${token}`] }, fetchImpl: async () => okResponse({ b130: 0.5 }) });
    const content = makeIndex(150, 200, (i) => (i === 130 ? ` token ${token}` : ''));
    await picker.pick(writeIndex(content), `User: here is ${token}`);
    const sent = JSON.stringify(calls[0].body);
    expect(sent).not.toContain(token);
    expect(calls[0].body.state).toContain('Sol = a Codex model');
    expect(calls[0].body.state).toContain('Glossary of our internal names');
  });

  it('a 401 drops the key and re-reads it only after KEY_REREAD_MS', async () => {
    let t = NOW;
    let reads = 0;
    const calls: number[] = [];
    const picker = new JevMemoryPicker({
      getConfig: () => ({ enabled: true }),
      readKey: () => { reads++; return 'k'; },
      logPath,
      fetchImpl: (async () => { calls.push(1); return { ok: false, status: 401, json: async () => ({}) }; }) as never,
      now: () => t,
    });
    const p = writeIndex(makeIndex(150, 200));
    expect((await picker.pick(p, 'x')).reason).toBe('http-error');
    expect((await picker.pick(p, 'x')).reason).toBe('disabled-no-key');
    expect(reads).toBe(1);
    t += KEY_REREAD_MS;
    expect((await picker.pick(p, 'x')).reason).toBe('http-error');
    expect(reads).toBe(2);
  });

  it('clamps config values', () => {
    const { picker } = makePicker({ cfg: { timeoutMs: 999_999, injectLines: -5, mode: 'bogus' as never, glossary: Array(50).fill('g') } });
    const cfg = picker.config()!;
    expect(cfg.timeoutMs).toBe(3000);
    expect(cfg.injectLines).toBe(0);
    expect(cfg.mode).toBe('shadow');
    expect(cfg.glossary).toHaveLength(20);
  });
});

describe('buildJevMemoryPicker — the dev gate and the kill switch', () => {
  const build = (live: unknown, developmentAgent: boolean) => buildJevMemoryPicker({
    readLiveIntelligence: () => live, developmentAgent, readSecret: () => 'k', stateDir: path.join(dir, '.instar'),
  });
  it('an omitted enabled is live on a development agent and dark on the fleet', () => {
    expect(build({}, true).config()).not.toBeNull();
    expect(build({}, false).config()).toBeNull();
  });
  it('explicit false is the kill switch on a dev agent; explicit true turns a fleet agent on', () => {
    expect(build({ jevMemoryPicker: { enabled: false } }, true).config()).toBeNull();
    expect(build({ jevMemoryPicker: { enabled: true } }, false).config()).not.toBeNull();
  });
  it('the mode is read live', () => {
    const live: { jevMemoryPicker: JevMemoryPickerConfig } = { jevMemoryPicker: {} };
    const picker = build(live, true);
    expect(picker.config()!.mode).toBe('shadow');
    live.jevMemoryPicker.mode = 'inject';
    expect(picker.config()!.mode).toBe('inject');
    live.jevMemoryPicker.enabled = false;
    expect(picker.config()).toBeNull();
  });
});

describe('helpers', () => {
  it('renderInjectBlock is empty with nothing to add, and headed otherwise', () => {
    expect(renderInjectBlock([])).toBe('');
    const entries = parseIndex('- [A](a.md) — a\n');
    expect(renderInjectBlock(entries)).toContain(INJECT_HEADER);
    expect(renderInjectBlock(entries)).toContain('- [A](a.md) — a');
  });
  it('topicOpeningContext uses the name and the last three messages, clamped', () => {
    const ctx = topicOpeningContext({ topicName: 'Jev', recentMessages: [1, 2, 3, 4].map((i) => ({ fromUser: i % 2 === 0, text: `m${i}` + 'z'.repeat(700) })) }, 'extra');
    expect(ctx.startsWith('Topic: Jev')).toBe(true);
    expect(ctx).not.toContain('m1');
    expect(ctx).toContain('User: m4');
    expect(ctx).toContain('Agent: m3');
    expect(ctx.endsWith('extra')).toBe(true);
    expect(topicOpeningContext(null, undefined)).toBe('');
  });
  it('pickSource closes the enum', () => {
    expect(pickSource('startup')).toBe('startup');
    expect(pickSource('compact')).toBe('compact');
    expect(pickSource('bogus')).toBe('other');
    expect(pickSource(undefined)).toBe('other');
  });
});
