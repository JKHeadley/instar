/**
 * Unit tests for JsonlUsageIndex — the incremental, non-blocking replacement for
 * QuotaCollector's old synchronous 7-day transcript rescan (incident 2026-09-22).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlUsageIndex } from '../../src/monitoring/JsonlUsageIndex.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 24 * 60 * 60 * 1000;

function assistantLine(tokens: number, tsMs = Date.now() - 60_000): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'assistant', usage: { input_tokens: tokens, output_tokens: 0 } },
  });
}

describe('JsonlUsageIndex', () => {
  let root: string;
  let projectDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-usage-index-'));
    projectDir = path.join(root, '-Users-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/jsonl-usage-index.test.ts' });
  });

  it('sums assistant usage in the window and ignores non-assistant, usage-less and out-of-window lines', async () => {
    const lines = [
      assistantLine(100),
      assistantLine(50),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'mentions "usage" in text' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
      assistantLine(9999, Date.now() - 10 * DAY), // older than the window
      'not json at all "usage"',
    ];
    fs.writeFileSync(path.join(projectDir, 'a.jsonl'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(projectDir, 'b.jsonl'), assistantLine(25) + '\n');
    // Non -Users- dirs and non-jsonl files are ignored
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(path.join(root, 'other', 'c.jsonl'), assistantLine(1_000) + '\n');
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), assistantLine(1_000) + '\n');

    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const pass = await index.update(Date.now() - 7 * DAY);

    expect(pass.complete).toBe(true);
    expect(pass.filesConsidered).toBe(2);
    expect(pass.totals.inputTokens).toBe(175);
    expect(pass.totals.totalBilled).toBe(175);
  });

  it('reads only appended bytes on the next pass', async () => {
    const file = path.join(projectDir, 'a.jsonl');
    fs.writeFileSync(file, assistantLine(100) + '\n');
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const since = Date.now() - 7 * DAY;

    const first = await index.update(since);
    expect(first.totals.totalBilled).toBe(100);
    const firstSize = fs.statSync(file).size;
    expect(first.bytesRead).toBe(firstSize);

    const appended = assistantLine(40) + '\n';
    fs.appendFileSync(file, appended);
    const second = await index.update(since);
    expect(second.totals.totalBilled).toBe(140);
    expect(second.bytesRead).toBe(Buffer.byteLength(appended));

    const third = await index.update(since);
    expect(third.bytesRead).toBe(0);
    expect(third.totals.totalBilled).toBe(140);
  });

  it('does not count a partially written line until it is completed, and never double-counts it', async () => {
    const file = path.join(projectDir, 'a.jsonl');
    const full = assistantLine(70);
    fs.writeFileSync(file, assistantLine(10) + '\n' + full.slice(0, 30));
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const since = Date.now() - 7 * DAY;

    const first = await index.update(since);
    expect(first.complete).toBe(true); // an in-progress line doesn't block completeness
    expect(first.totals.totalBilled).toBe(10);

    fs.appendFileSync(file, full.slice(30) + '\n');
    const second = await index.update(since);
    expect(second.totals.totalBilled).toBe(80);

    const third = await index.update(since);
    expect(third.totals.totalBilled).toBe(80);
  });

  it('counts a complete final line without a trailing newline exactly once', async () => {
    const file = path.join(projectDir, 'a.jsonl');
    fs.writeFileSync(file, assistantLine(10) + '\n' + assistantLine(20));
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const since = Date.now() - 7 * DAY;

    expect((await index.update(since)).totals.totalBilled).toBe(30);
    fs.appendFileSync(file, '\n' + assistantLine(5) + '\n');
    expect((await index.update(since)).totals.totalBilled).toBe(35);
  });

  it('respects the per-pass byte budget: incomplete first, correct once caught up', async () => {
    for (let i = 0; i < 5; i++) {
      const lines = Array.from({ length: 20 }, () => assistantLine(1)).join('\n') + '\n';
      fs.writeFileSync(path.join(projectDir, `f${i}.jsonl`), lines);
    }
    const oneFileBytes = fs.statSync(path.join(projectDir, 'f0.jsonl')).size;
    const index = new JsonlUsageIndex({
      claudeProjectsDir: root,
      maxBytesPerPass: oneFileBytes * 2,
      chunkBytes: 256,
    });
    const since = Date.now() - 7 * DAY;

    const first = await index.update(since);
    expect(first.complete).toBe(false);
    expect(first.bytesRead).toBeLessThanOrEqual(oneFileBytes * 2);

    let pass = first;
    for (let i = 0; i < 10 && !pass.complete; i++) pass = await index.update(since);
    expect(pass.complete).toBe(true);
    expect(pass.totals.totalBilled).toBe(100);
  });

  it('rebuilds from zero when a file shrinks, so nothing is double-counted', async () => {
    const a = path.join(projectDir, 'a.jsonl');
    const b = path.join(projectDir, 'b.jsonl');
    fs.writeFileSync(a, assistantLine(100) + '\n' + assistantLine(100) + '\n');
    fs.writeFileSync(b, assistantLine(7) + '\n');
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const since = Date.now() - 7 * DAY;
    expect((await index.update(since)).totals.totalBilled).toBe(207);

    fs.writeFileSync(a, assistantLine(1) + '\n'); // rewritten, smaller
    const after = await index.update(since);
    expect(after.complete).toBe(true);
    expect(after.totals.totalBilled).toBe(8);
  });

  it('yields to the event loop while scanning', async () => {
    const lines = Array.from({ length: 500 }, () => assistantLine(1)).join('\n') + '\n';
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(projectDir, `f${i}.jsonl`), lines);
    let yields = 0;
    const index = new JsonlUsageIndex({
      claudeProjectsDir: root,
      yieldEveryLines: 100,
      yieldFn: () => { yields++; return new Promise(r => setImmediate(r)); },
    });
    const pass = await index.update(Date.now() - 7 * DAY);
    expect(pass.totals.totalBilled).toBe(1500);
    // 15 line-yields (1500 / 100) + 3 per-file + 1 per project dir
    expect(yields).toBeGreaterThanOrEqual(15);
  });

  it('shares one in-flight pass between concurrent callers', async () => {
    fs.writeFileSync(path.join(projectDir, 'a.jsonl'), assistantLine(10) + '\n');
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const since = Date.now() - 7 * DAY;
    const [p1, p2] = [index.update(since), index.update(since)];
    expect(p1).toBe(p2);
    const r = await p1;
    expect(r.totals.totalBilled).toBe(10);
  });

  it('counts each requestId once, like the TokenLedger (usage repeats on every content-block line)', async () => {
    const withReq = (req: string, tokens: number) => JSON.stringify({
      type: 'assistant',
      requestId: req,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: { role: 'assistant', usage: { input_tokens: tokens, output_tokens: 0 } },
    });
    const file = path.join(projectDir, 'a.jsonl');
    // One request streamed as three content-block lines, plus a distinct request.
    fs.writeFileSync(file, [withReq('req_1', 100), withReq('req_1', 100), withReq('req_1', 100), withReq('req_2', 5)].join('\n') + '\n');
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const since = Date.now() - 7 * DAY;
    expect((await index.update(since)).totals.totalBilled).toBe(105);

    // The same request id seen again later (e.g. another file) still counts once.
    fs.writeFileSync(path.join(projectDir, 'b.jsonl'), withReq('req_1', 100) + '\n');
    expect((await index.update(since)).totals.totalBilled).toBe(105);
  });

  it('keeps a file cursor past the window edge so a later append never re-counts boundary-hour entries', async () => {
    const file = path.join(projectDir, 'edge.jsonl');
    const now = Date.now();
    const since = now - 7 * DAY;
    // An entry inside the window's boundary hour, in a file whose mtime has
    // slipped just past the window start (but within the hour of grace).
    fs.writeFileSync(file, assistantLine(10, since + 60_000) + '\n');
    const stale = (since - 10 * 60_000) / 1000;
    fs.utimesSync(file, stale, stale);
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const first = await index.update(since);
    expect(first.totals.totalBilled).toBe(10);
    expect(index.trackedFileCount()).toBe(1);

    fs.appendFileSync(file, assistantLine(1) + '\n'); // append bumps mtime back into the window
    const second = await index.update(since);
    expect(second.totals.totalBilled).toBe(11); // 10 counted once, not twice
  });

  it('drops files that fall out of the window and returns an empty, complete result for a missing dir', async () => {
    const file = path.join(projectDir, 'a.jsonl');
    fs.writeFileSync(file, assistantLine(10, Date.now() - 9 * DAY) + '\n');
    const old = (Date.now() - 9 * DAY) / 1000;
    fs.utimesSync(file, old, old);
    const index = new JsonlUsageIndex({ claudeProjectsDir: root });
    const pass = await index.update(Date.now() - 7 * DAY);
    expect(pass.filesConsidered).toBe(0);
    expect(index.trackedFileCount()).toBe(0);
    expect(pass.totals.totalBilled).toBe(0);

    const missing = new JsonlUsageIndex({ claudeProjectsDir: path.join(root, 'nope') });
    const r = await missing.update(Date.now() - 7 * DAY);
    expect(r.complete).toBe(true);
    expect(r.filesConsidered).toBe(0);
  });
});
