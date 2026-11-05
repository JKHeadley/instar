/**
 * ConversationGraphStore: the durable event file behind the Conversations hierarchy.
 * - an append survives a reload; an identical duplicate is a no-op; a differing duplicate is refused;
 * - a torn final line is truncated on load and the earlier lines are intact;
 * - an invalid line is skipped and counted, never rewritten;
 * - a differing duplicate already on disk reaches the reducer, which quarantines it.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ConversationGraphStore } from '../../src/core/ConversationGraphStore.js';
import { reduceGraph, type GraphEvent } from '../../src/core/conversationGraph.js';

const roots: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-')); roots.push(d); return d; }
afterAll(() => { for (const d of roots) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ConversationGraphStore.test.ts' }); });

const tg = (topicId: number) => ({ kind: 'conversation' as const, platform: 'telegram' as const, chatId: '-1001234567890', topicId });
const eff = (n: number) => ({ kind: 'effort' as const, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
function place(eventId: string, subject: ReturnType<typeof tg>, parent: ReturnType<typeof eff> | null): GraphEvent {
  return {
    schemaVersion: 1, eventId, op: 'set-primary-placement', subject, parent, relation: parent ? 'coordinates' : null,
    replacesPlacementEventIds: [], authority: 'owner', principal: 'owner', receipt: { kind: 'owner-proof', id: `r-${eventId}` },
    machineId: 'm1', createdAt: '2026-11-05T09:30:00.000Z',
  };
}

describe('ConversationGraphStore', () => {
  it('commits, reloads, and de-duplicates', () => {
    const dir = tmp();
    const s = new ConversationGraphStore(dir);
    expect(s.append(place('event-0001', tg(1), eff(1))).appended).toBe(true);
    expect(s.append(place('event-0001', tg(1), eff(1))).appended).toBe(false);
    expect(() => s.append(place('event-0001', tg(1), eff(2)))).toThrow(/different event/);
    const again = new ConversationGraphStore(dir);
    expect(again.events()).toHaveLength(1);
    expect((again.events()[0] as { parent: unknown }).parent).toEqual(eff(1));
  });

  it('refuses an invalid event and writes nothing', () => {
    const dir = tmp();
    const s = new ConversationGraphStore(dir);
    expect(() => s.append({ ...place('event-0002', tg(1), null), authority: 'root' })).toThrow(/invalid/);
    expect(fs.existsSync(s.file)).toBe(false);
  });

  it('truncates a torn final line on load and keeps earlier lines', () => {
    const dir = tmp();
    const s = new ConversationGraphStore(dir);
    s.append(place('event-0003', tg(1), eff(1)));
    fs.appendFileSync(s.file, '{"schemaVersion":1,"eventId":"torn');
    const reports: string[] = [];
    const again = new ConversationGraphStore(dir, (m) => reports.push(m));
    expect(again.events()).toHaveLength(1);
    expect(again.health().tornTailRepaired).toBe(true);
    expect(reports.join(' ')).toMatch(/torn final line/);
    expect(fs.readFileSync(s.file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('skips and counts an invalid complete line without rewriting the file', () => {
    const dir = tmp();
    const s = new ConversationGraphStore(dir);
    s.append(place('event-0004', tg(1), eff(1)));
    fs.appendFileSync(s.file, '{"not":"an event"}\n');
    const before = fs.readFileSync(s.file, 'utf8');
    const again = new ConversationGraphStore(dir);
    expect(again.events()).toHaveLength(1);
    expect(again.health().skippedInvalidLines).toBe(1);
    expect(fs.readFileSync(s.file, 'utf8')).toBe(before);
  });

  it('a differing duplicate already on disk reaches the reducer and is quarantined', () => {
    const dir = tmp();
    const s = new ConversationGraphStore(dir);
    s.append(place('event-0005', tg(1), eff(1)));
    fs.appendFileSync(s.file, `${JSON.stringify(place('event-0005', tg(1), eff(2)))}\n`);
    const g = reduceGraph(new ConversationGraphStore(dir).events(), { verify: () => true });
    expect(g.setAside).toEqual([{ eventId: 'event-0005', reason: 'duplicate-event-id-different-payload' }]);
    expect(g.parentOf.size).toBe(0);
  });

  it('a failed write commits nothing and leaves no fragment (finding 8)', () => {
    const dir = tmp();
    const s = new ConversationGraphStore(dir);
    s.append(place('event-0006', tg(1), eff(1)));
    const before = fs.readFileSync(s.file, 'utf8');
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk gone'); });
    try {
      expect(() => s.append(place('event-0007', tg(2), eff(1)))).toThrow(/disk gone/);
    } finally { spy.mockRestore(); }
    expect(fs.readFileSync(s.file, 'utf8')).toBe(before);
    expect(new ConversationGraphStore(dir).events()).toHaveLength(1);
  });
});
