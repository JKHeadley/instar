/**
 * Security review fixes for stage 0 part C: one approval admits one call even under a race; an input
 * the card cannot show is never approvable once; approvals expire; legacy status is compared by change
 * id and never revived by a joining machine; a part-way import resumes; card text cannot be reordered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { createTrustJourneyRuntime, escapeForCard } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { TrustJourneyStore, type TrustRecord } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { deriveEffect } from '../../src/data/effect-kinds.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-review-c-')); fs.writeFileSync(path.join(dir, 'config.json'), '{}'); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/trust-journey-review-c.test.ts' }); });

/** A sink whose append waits, like the journal's durable wait. */
function slowSink() {
  const rows: TrustRecord[] = [];
  return { description: 'slow', rows, loadAll: () => rows, append: async (k: string, r: TrustRecord) => { await new Promise((res) => setTimeout(res, 30)); rows.push({ ...r, recordKey: k }); return true; } };
}
const mk = (opts: { sink?: ReturnType<typeof slowSink>; machineId?: string; imported?: { v: boolean }; mcp?: string[] } = {}) => createTrustJourneyRuntime({
  stateDir: dir, configPath: path.join(dir, 'config.json'), runtimeConfig: {}, installationId: 'x', machineId: opts.machineId ?? 'm1', sink: opts.sink,
  adaptiveTrust: new AdaptiveTrust({ stateDir: dir }), autonomyManager: null, trustRecovery: null, telegram: null, slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
  ...(opts.imported ? { legacyImport: { gateEnabled: true, gateServices: ['svc'], readOnlyServices: [], logServices: () => [], mcpServers: () => opts.mcp ?? [], alreadyImported: () => opts.imported!.v, markImported: () => { opts.imported!.v = true; return true; } } } : {}),
});

describe('one approval, one call', () => {
  it('two identical calls racing on a slow (journal-like) sink admit once', async () => {
    const sink = slowSink();
    const r = mk({ sink });
    const e = deriveEffect('mcp__svc__send_note', { a: 1 })!;
    await r.store.write('action-approval', { approvalId: 'ap1', actionIdentity: e.actionIdentity, consumptionId: 'c1', expiresAt: '2099-01-01T00:00:00Z' });
    const [x, y] = await Promise.all([r.admit('mcp__svc__send_note', { a: 1 }), r.admit('mcp__svc__send_note', { a: 1 })]);
    expect([x.decision.verdict, y.decision.verdict].sort()).toEqual(['ask', 'proceed-once']);
  });
  it('an expired approval admits nothing', async () => {
    const r = mk();
    const e = deriveEffect('mcp__svc__send_note', { a: 1 })!;
    await r.store.write('action-approval', { approvalId: 'ap1', actionIdentity: e.actionIdentity, consumptionId: 'c1', expiresAt: '2020-01-01T00:00:00Z' });
    expect((await r.admit('mcp__svc__send_note', { a: 1 })).decision.verdict).toBe('ask');
  });
  it('a stand-in or oversized input is never approvable once and sends no card', async () => {
    const r = mk();
    const e = deriveEffect('mcp__svc__send_note', { _truncated: true })!;
    await r.store.write('action-approval', { approvalId: 'ap1', actionIdentity: e.actionIdentity, consumptionId: 'c1', expiresAt: '2099-01-01T00:00:00Z' });
    const res = await r.admit('mcp__svc__send_note', { _truncated: true });
    expect(res.decision.verdict).toBe('ask');
    expect(res.ask?.status).toBe('too-large');
    expect((await r.admit('mcp__svc__send_note', { body: 'x'.repeat(3000) })).ask?.status).toBe('too-large');
  });
});

describe('legacy status', () => {
  it('a person-set change ends legacy status; a later joining machine does not revive it', async () => {
    const imported = { v: false };
    const a = mk({ imported });
    await a.importLegacyAndWriteFallback();
    expect((await a.admit('mcp__svc__send_note', {})).decision.verdict).toBe('legacy');
    await a.store.write('change', { changeId: 'svc.write:1', key: 'svc.write', from: 'log', to: 'approve-always', direction: 'lower', source: 'person' });
    expect((await a.admit('mcp__svc__send_note', {})).decision.verdict).toBe('ask');
    // Machine m2 joins: svc.write is no longer unchanged-legacy anywhere, so m2 does not import it.
    const b = mk({ machineId: 'm2', imported: { v: false } });
    await b.importLegacyAndWriteFallback();
    expect(b.store.legacyGrants('svc.write').some((g) => g.machine === 'm2')).toBe(false);
    expect(b.store.legacyGrants('svc.modify').some((g) => g.machine === 'm2')).toBe(true);
  });
  it('when every legacy kind was changed, a joining machine imports nothing', async () => {
    const a = mk({ imported: { v: false } });
    await a.importLegacyAndWriteFallback();
    for (const k of a.store.legacyKeys()) {
      await a.store.write('change', { changeId: `${k}:1`, key: k, from: 'log', to: 'approve-always', direction: 'lower', source: 'person' });
    }
    expect(a.store.unchangedLegacyKeys()).toEqual([]);
    const b = mk({ machineId: 'm2', imported: { v: false }, mcp: ['other'] });
    await b.importLegacyAndWriteFallback();
    expect(b.store.legacyKeys().some((k) => b.store.legacyGrants(k).some((g) => g.machine === 'm2'))).toBe(false);
    expect((await b.admit('mcp__svc__send_note', {})).decision.verdict).toBe('ask');
  });
  it('an import that stopped part-way resumes and sets the marker', async () => {
    const imported = { v: false };
    const a = mk({ imported });
    await a.store.write('legacy-grant', { key: 'svc.delete', machine: 'm1', behaviour: 'gate', afterChange: null }, 'tj:legacy:m1:svc.delete');
    const r = await a.importLegacyAndWriteFallback();
    expect(r.skipped).toBeUndefined();
    expect(imported.v).toBe(true);
    expect(r.fileWritten).toBe(true);
  });
});

describe('card text', () => {
  it('escapes direction overrides, zero-width marks and line separators', () => {
    expect(escapeForCard('{"to":"a‮b​c d"}')).toBe('{"to":"a\\u202eb\\u200bc\\u2028d"}');
  });
});
