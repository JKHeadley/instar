// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * AutonomousRunStore — Tier 1 (spec: autonomous-scope-accretion-completion.md
 * R28/R30/R43).
 *
 * Covers: registration + server-minted runId; endAt clamp (a session cannot
 * register an unbounded run); 409-while-active semantics + lazy archive of a
 * terminal predecessor; lifecycle terminality (one-way, first exit wins);
 * breaker state persisted across store instances (server restart); monotone
 * corroboration + 5-minute negative TTL; sessionId↔topicId map; conformance
 * invocation records (R32) windowing; the R28b daily sweep.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousRunStore, hashPathSet } from '../../src/core/AutonomousRunStore.js';

let tmp: string;
let store: AutonomousRunStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ars-'));
  store = new AutonomousRunStore(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HOUR = 3_600_000;

function reg(topicId = '100', overrides: Record<string, unknown> = {}) {
  return store.register({
    topicId,
    condition: 'ship the feature',
    workDir: tmp,
    startedAt: new Date().toISOString(),
    scopeAccretion: { enabled: true, breakerK: 3 },
    baseRoots: [{ root: tmp, startSha: null, shared: false }],
    maxDurationMs: 48 * HOUR,
    ...overrides,
  } as Parameters<AutonomousRunStore['register']>[0]);
}

describe('registration (R30/R43/R49)', () => {
  it('mints a server-side runId and persists a server-owned record', () => {
    const r = reg();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runId).toMatch(/^run-/);
    const rec = store.getRecord('100')!;
    expect(rec.status).toBe('active');
    expect(rec.scopeAccretion).toEqual({ enabled: true, breakerK: 3 });
    // Written only by the server, under state/autonomous-server/.
    expect(fs.existsSync(path.join(tmp, 'state', 'autonomous-server', `100.${r.runId}.json`))).toBe(true);
  });

  it('CLAMPS endAt to now + maxDurationMs — a session cannot register an unbounded run', () => {
    const farFuture = new Date(Date.now() + 400 * HOUR).toISOString();
    const r = reg('101', { endAt: farFuture });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clamped).toBe(true);
    expect(Date.parse(r.endAt)).toBeLessThanOrEqual(Date.now() + 48 * HOUR + 5_000);
  });

  it('REFUSES a re-register while the existing record is active and unexpired (409 semantics)', () => {
    const first = reg('102');
    expect(first.ok).toBe(true);
    const second = reg('102');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflict).toBe(true);
    expect(second.existingRunId).toBe((first as { ok: true; runId: string }).runId);
  });

  it('lazily archives a TERMINAL predecessor — an early-finished run never blocks the next registration (R28a)', () => {
    const first = reg('103');
    if (!first.ok) throw new Error('setup');
    store.markTerminal('103', first.runId, 'met', 'done');
    const second = reg('103');
    expect(second.ok).toBe(true);
    // The predecessor got the .archived.json rename.
    const archived = fs.readdirSync(path.join(tmp, 'state', 'autonomous-server')).filter((n) => n.endsWith('.archived.json'));
    expect(archived).toHaveLength(1);
  });

  it('an EXPIRED record self-clears at endAt — a crashed run never wedges the topic', () => {
    const first = store.register({
      topicId: '104',
      condition: 'x',
      workDir: tmp,
      startedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
      endAt: new Date(Date.now() - HOUR).toISOString(),
      scopeAccretion: { enabled: true, breakerK: 3 },
      baseRoots: [],
      maxDurationMs: 48 * HOUR,
    });
    // endAt in the past is clamped forward at registration — so simulate expiry
    // by rewriting the record's endAt (the crash case: registered long ago).
    if (!first.ok) throw new Error('setup');
    store.update('104', first.runId, (r) => {
      r.endAt = new Date(Date.now() - HOUR).toISOString();
    });
    const second = reg('104');
    expect(second.ok).toBe(true);
  });
});

describe('lifecycle terminality (R43 — one-way, first exit wins)', () => {
  it('markTerminal is one-way and never overwrites a terminal status', () => {
    const r = reg('110');
    if (!r.ok) throw new Error('setup');
    store.markTerminal('110', r.runId, 'met', 'judge met');
    store.markTerminal('110', r.runId, 'ended', 'run-end after met');
    const rec = store.getByPair('110', r.runId)!;
    expect(rec.status).toBe('met');
    expect(rec.endReason).toBe('judge met');
    expect(store.isActive(rec)).toBe(false);
  });

  it('listActive excludes terminal and expired records', () => {
    const a = reg('120');
    const b = reg('121');
    if (!a.ok || !b.ok) throw new Error('setup');
    store.markTerminal('121', b.runId, 'ended');
    const active = store.listActive();
    expect(active.map((r) => r.topicId)).toEqual(['120']);
  });
});

describe('breaker + corroboration persistence (R21/R22/R26)', () => {
  it('breaker state survives a server restart (new store instance, same disk)', () => {
    const r = reg('130');
    if (!r.ok) throw new Error('setup');
    const setHash = hashPathSet(['docs/specs/a.md']);
    store.update('130', r.runId, (rec) => {
      rec.breaker = { accretedSetHash: setHash, firstSeenAt: new Date().toISOString(), consecutiveHolds: 2, lastProgressAt: '', clearedCount: 0, tripped: false };
    });
    const store2 = new AutonomousRunStore(tmp);
    const rec = store2.getByPair('130', r.runId)!;
    expect(rec.breaker.consecutiveHolds).toBe(2);
    expect(rec.breaker.accretedSetHash).toBe(setHash);
  });

  it('positive corroboration is MONOTONE (never re-queried, never demoted) and clears the negative stamp', () => {
    const r = reg('131');
    if (!r.ok) throw new Error('setup');
    store.recordNegative('131', r.runId, 'docs/specs/a.md');
    expect(store.isNegativeCached(store.getByPair('131', r.runId)!, 'docs/specs/a.md')).toBe(true);
    store.recordCorroboration('131', r.runId, 'docs/specs/a.md', 'merged-pr', '#42');
    const rec = store.getByPair('131', r.runId)!;
    expect(rec.corroborated['docs/specs/a.md']).toMatchObject({ by: 'merged-pr' });
    expect(store.isNegativeCached(rec, 'docs/specs/a.md')).toBe(false);
    // A later recordCorroboration never overwrites the first evidence.
    store.recordCorroboration('131', r.runId, 'docs/specs/a.md', 'local-git-origin-main');
    expect(store.getByPair('131', r.runId)!.corroborated['docs/specs/a.md'].by).toBe('merged-pr');
  });

  it('the negative cache expires after 5 minutes (TTL)', () => {
    const r = reg('132');
    if (!r.ok) throw new Error('setup');
    store.recordNegative('132', r.runId, 'docs/specs/a.md');
    const rec = store.getByPair('132', r.runId)!;
    expect(store.isNegativeCached(rec, 'docs/specs/a.md', Date.now())).toBe(true);
    expect(store.isNegativeCached(rec, 'docs/specs/a.md', Date.now() + 6 * 60_000)).toBe(false);
  });
});

describe('session map (§2.3 — feeds the ADVISORY ledger only)', () => {
  it('maps sessionId ↔ topicId/runId and resolves it back', () => {
    const r = reg('140', { sessionId: 'abc-session' });
    if (!r.ok) throw new Error('setup');
    expect(store.resolveSession('abc-session')).toEqual({ topicId: '140', runId: r.runId });
    expect(store.resolveSession('unknown')).toBeNull();
  });
});

describe('conformance invocation records (R32 — server-recorded ceremony evidence)', () => {
  it('records invocations keyed by slug and windows them', () => {
    const t0 = new Date(Date.now() - 2 * HOUR).toISOString();
    store.recordConformanceInvocation('my-spec', new Date(Date.now() - HOUR).toISOString());
    store.recordConformanceInvocation('my-spec', new Date().toISOString());
    store.recordConformanceInvocation('other-spec');
    expect(store.conformanceInvocationsInWindow('my-spec', t0, new Date(Date.now() + 1000).toISOString())).toBe(2);
    // A window that PREDATES the run sees nothing — a forged report without an
    // in-window ceremony run has no server record (R32).
    expect(store.conformanceInvocationsInWindow('my-spec', new Date(Date.now() + HOUR).toISOString(), new Date(Date.now() + 2 * HOUR).toISOString())).toBe(0);
    expect(store.conformanceInvocationsInWindow('never-checked', t0, new Date().toISOString())).toBe(0);
  });
});

describe('daily sweep (R28b — the crash/tamper backstop)', () => {
  it('reaps a still-active record whose endAt passed >24h ago and returns it for the loud enumeration', () => {
    const r = reg('150');
    if (!r.ok) throw new Error('setup');
    store.update('150', r.runId, (rec) => {
      rec.endAt = new Date(Date.now() - 25 * HOUR).toISOString();
      rec.lastUnbuilt = [{ path: 'docs/specs/abandoned.md', cls: 'deliverable', deleted: false, firstSeenAt: new Date().toISOString() }];
    });
    const reaped = store.dailySweep(Date.now(), true);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].lastUnbuilt[0].path).toBe('docs/specs/abandoned.md');
    // Archived — no longer the topic's record.
    expect(store.getRecord('150')).toBeNull();
  });

  it('a recently-ended record is archived silently (not returned for enumeration)', () => {
    const r = reg('151');
    if (!r.ok) throw new Error('setup');
    store.markTerminal('151', r.runId, 'ended');
    store.update('151', r.runId, (rec) => {
      rec.endAt = new Date(Date.now() - 25 * HOUR).toISOString();
    });
    const reaped = store.dailySweep(Date.now(), true);
    expect(reaped).toHaveLength(0);
  });
});

describe('advisory artifact ledger (R18)', () => {
  it('appends JSONL entries under the server store dir', () => {
    const r = reg('160');
    if (!r.ok) throw new Error('setup');
    store.appendAdvisoryArtifact('160', r.runId, { filePath: 'docs/specs/x.md', toolName: 'Write', sessionId: 's1' });
    const f = path.join(tmp, 'state', 'autonomous-server', `160.${r.runId}.artifacts.jsonl`);
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ filePath: 'docs/specs/x.md', toolName: 'Write' });
  });
});
