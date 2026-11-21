// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the layer ticker skips a fold's lock window (context-budget-layered-
 * summaries §10 suppression carrier; Phase 2). The handoff request and its
 * reply are internal turns: they must never become the conversation's
 * current-work awareness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayerTicker, dropLockWindows } from '../../src/monitoring/contextLayers/layerTicker.js';
import { TopicLayerBudget } from '../../src/monitoring/contextLayers/layerCadence.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-layer-lock-window.test.ts';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

const line = (uuid: string, text: string, type = 'user') => JSON.stringify({ type, uuid, message: { content: [{ type: 'tool_result', content: text }] } });

describe('dropLockWindows', () => {
  const lines = [line('a', 'before'), line('b', 'last before inject'), line('c', 'HANDOFF REQUEST'), line('d', 'HANDOFF REPLY', 'assistant'), line('e', 'after')];
  it('drops everything after fromEntry up to and including toEntry', () => {
    expect(dropLockWindows(lines, [{ fromEntry: 'b', toEntry: 'd' }])).toEqual([lines[0], lines[1], lines[4]]);
  });
  it('an open window (no toEntry) drops everything after its start', () => {
    expect(dropLockWindows(lines, [{ fromEntry: 'b' }])).toEqual([lines[0], lines[1]]);
  });
  it('no window, or a window with neither end in the tail, keeps every line', () => {
    expect(dropLockWindows(lines, [])).toEqual(lines);
    expect(dropLockWindows(lines, [{ fromEntry: 'zz', toEntry: 'yy' }])).toEqual(lines);
    expect(dropLockWindows(lines, [{ fromEntry: 'zz' }])).toEqual(lines);
  });
  it('a window closed early (no toEntry) ends at the first entry after its close time, so later real work is kept', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 10, 20, 12, min)).toISOString();
    const at = (uuid: string, text: string, min: number) => JSON.stringify({ type: 'user', uuid, timestamp: t(min), message: { content: [{ type: 'tool_result', content: text }] } });
    const ls = [at('a', 'before', 0), at('b', 'last before inject', 1), at('c', 'HANDOFF REQUEST', 2), at('d', 'late work', 10), at('e', 'more work', 11)];
    const kept = dropLockWindows(ls, [{ fromEntry: 'b', closedAt: Date.parse(t(5)) }]).map((l) => JSON.parse(l).uuid);
    expect(kept).toEqual(['a', 'b', 'd', 'e']);
  });

  it('a window whose start scrolled out of the tail but whose end is in it is dropped from the top', () => {
    const tail = [line('c', 'HANDOFF REQUEST'), line('d', 'HANDOFF REPLY', 'assistant'), line('e', 'after')];
    expect(dropLockWindows(tail, [{ fromEntry: 'b', toEntry: 'd' }]).map((l) => JSON.parse(l).uuid)).toEqual(['e']);
  });

  it('several windows are each skipped', () => {
    const more = [...lines, line('f', 'R2'), line('g', 'R2 reply', 'assistant'), line('h', 'end')];
    expect(dropLockWindows(more, [{ fromEntry: 'b', toEntry: 'd' }, { fromEntry: 'e', toEntry: 'g' }]).map((l) => JSON.parse(l).uuid)).toEqual(['a', 'b', 'e', 'h']);
  });
});

describe('LayerTicker with lock windows', () => {
  it('a tick never feeds the handoff turn to the extractor', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-')); dirs.push(d);
    const f = path.join(d, 's.jsonl');
    fs.writeFileSync(f, `${line('a', 'start')}\n`);
    const fed: string[] = [];
    let now = 0;
    const ticker = new LayerTicker({
      sessions: () => [{ topicId: 141133, sessionKey: 's1', transcriptPath: f, tmuxSession: 'tm' }],
      midTurn: () => false, budget: new TopicLayerBudget(), now: () => now, baseMs: 1,
      ingest: async (_s, dg) => { fed.push(dg.text); return 'updated' as const; },
      lockWindows: (topicId) => (topicId === 141133 ? [{ fromEntry: 'b', toEntry: 'd' }] : []),
    });
    await ticker.pass(); // baseline
    fs.appendFileSync(f, [line('b', 'real work output'), line('c', 'HANDOFF REQUEST internal'), line('d', 'HANDOFF REPLY internal', 'assistant'), line('e', 'more real work')].join('\n') + '\n');
    now = 10;
    await ticker.pass();
    expect(fed).toHaveLength(1);
    expect(fed[0]).toContain('real work output');
    expect(fed[0]).toContain('more real work');
    expect(fed[0]).not.toContain('HANDOFF');
  });
});
